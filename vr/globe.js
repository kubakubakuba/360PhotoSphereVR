import * as THREE from 'three';
import { angularDistance, itemCoordinates, latLonToVector3, vector3ToLatLon, wrapLon } from './geo.js';
import { TileLayer } from './globe-tiles.js';
import { easeInOutCubic } from './transitions.js';

// An Earth globe with a pin per geotagged photo, shared by the desktop map and the VR globe.
// The host decides where the globe sits: `place(globe)` positions the camera (desktop) or the
// globe itself (VR) for the current altitude. Altitude is measured in globe radii above the surface.

const DEG = Math.PI / 180;
const EARTH_URL = new URL('../lib/earth/blue-marble.jpg', import.meta.url).href;
const EARTH_COLOR = 0x10263d; // shown until the texture has loaded
const EARTH_TEXTURE_PX_PER_RADIAN = 4096 / (2 * Math.PI);
const OFFLINE_MAGNIFICATION = 4; // how far the bundled texture may be zoomed into without tiles
const MAX_LAT = 85;
const MERGE_FACTOR = 2.4; // pins closer than this many pin radii merge into a cluster
const CLUSTER_PIN_SCALE = 1.4; // pins with a count are drawn larger so the number stays readable
const GROUP_SPREAD = 5e-6; // rad (~30 m): photos this close count as one place
const RECLUSTER_RATIO = 1.1;
const INERTIA_DAMPING = 5;
const FLY_DURATION = 0.9;
const VIEW_STORAGE_KEY = 'pano-globe-view'; // where the globe was left, per browser
const VIEW_SAVE_INTERVAL = 1; // s; also saved on close, this covers reloads and ended VR sessions

let pinGeometry = null;

// Accent dot with a white ring and a dark outline, readable on light and dark ground alike.
// Pins of several photos show the count.
function makePinTexture(count, accent) {
	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	const center = size / 2;
	const disc = (radius, color) => {
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(center, center, radius, 0, Math.PI * 2);
		ctx.fill();
	};
	disc(54, 'rgba(5, 10, 15, 0.6)');
	disc(47, '#ffffff');
	disc(37, accent);
	if (count > 1) {
		ctx.fillStyle = '#05221a';
		ctx.font = `700 ${count > 99 ? 30 : 42}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(count > 99 ? '99+' : String(count), center, center + 2);
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

// MeshBasicMaterial that fades out with distance from the focus point (a round "map window"
// when the VR globe is zoomed in far enough to be larger than the user's view).
function createFadeMaterial(uniforms, options = {}) {
	const material = new THREE.MeshBasicMaterial({ transparent: true, ...options });
	material.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
		shader.vertexShader = `varying vec3 vGlobeWorld;\n${shader.vertexShader.replace(
			'#include <project_vertex>',
			'#include <project_vertex>\n\tvGlobeWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
		)}`;
		shader.fragmentShader = `uniform vec3 fadeCenter;\nuniform float fadeRadius;\nuniform float fadeWidth;\nuniform float globeOpacity;\nvarying vec3 vGlobeWorld;\n${shader.fragmentShader.replace(
			'#include <opaque_fragment>',
			'diffuseColor.a *= globeOpacity * (1.0 - smoothstep(fadeRadius - fadeWidth, fadeRadius, distance(vGlobeWorld, fadeCenter)));\n\tif (diffuseColor.a < 0.004) discard; // faded out completely\n\t#include <opaque_fragment>',
		)}`;
	};
	material.customProgramCacheKey = () => 'globe-fade';
	return material;
}

export class Globe extends THREE.Group {
	/**
	 * @param place        (globe) => void, lays out the camera or the globe for globe.view.altitude
	 * @param fade         { radius, width } in world units, or null for no fade
	 * @param minAltitude  lowest altitude the host allows (on top of the detail limit)
	 * @param tileCache    map tiles kept loaded (see TileLayer)
	 * @param pixelsPerRadian  display density, see update()
	 */
	constructor({
		items = [], current = null, accent = '#43cea2', tileUrl = '', tileMaxZoom = 17, tileCache = 256,
		place, fade = null, minAltitude = 0, maxAltitude = 3, pixelsPerRadian = 1000,
	} = {}) {
		super();
		this.accent = accent;
		this.place = place;
		this.hostMinAltitude = minAltitude;
		this.maxAltitude = maxAltitude;
		this.view = { lat: 20, lon: 0, altitude: maxAltitude };
		this.flight = null;
		this.velocity = { lat: 0, lon: 0 };
		this.dragDelta = { lat: 0, lon: 0 };
		this.dragAnchor = null;
		this.ready = false;
		this.opacity = 1;
		this.pixelsPerRadian = pixelsPerRadian;
		this.mergeAngle = 0;
		this.clusterAltitude = 0;
		this.pinTextures = new Map();
		this.clusters = [];

		this.uniforms = {
			fadeCenter: { value: new THREE.Vector3() },
			fadeRadius: { value: fade ? fade.radius : 1e9 },
			fadeWidth: { value: fade ? fade.width : 1 },
			globeOpacity: { value: 1 },
		};

		// Everything in globe coordinates lives in `body`, which turns the focus point toward +Z.
		this.body = new THREE.Group();
		this.add(this.body);

		// No depth writes: tiles (flatter than the sphere when coarse) must not hide behind it.
		// Back-face culling keeps the far side of the Earth and of the tiles out of view.
		const earthMaterial = createFadeMaterial(this.uniforms, { color: EARTH_COLOR, depthWrite: false });
		this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), earthMaterial);
		this.earth.renderOrder = 0;
		this.earth.userData = { hover: 0, earth: true };
		this.body.add(this.earth);
		this.earthTexture = new THREE.TextureLoader().load(EARTH_URL, (texture) => {
			if (this.disposed) return;
			earthMaterial.map = texture;
			earthMaterial.color.set(0xffffff);
			earthMaterial.needsUpdate = true;
			this.ready = true;
		}, undefined, (error) => console.warn('Could not load the Earth texture:', error));
		this.earthTexture.colorSpace = THREE.SRGBColorSpace;
		this.earthTexture.anisotropy = 8;

		this.tiles = new TileLayer({
			url: tileUrl,
			maxZoom: tileMaxZoom,
			maxCached: tileCache,
			createMaterial: () => createFadeMaterial(this.uniforms, { depthWrite: false }),
		});
		this.body.add(this.tiles);

		this.pins = new THREE.Group();
		this.body.add(this.pins);

		this.setItems(items, current);
	}

	// --- Items and pins ----------------------------------------------------

	setItems(items, current = this.current) {
		this.items = items
			.map((item) => ({ item, coordinates: itemCoordinates(item) }))
			.filter((entry) => entry.coordinates);
		this.current = current;
		this.clusterAltitude = 0; // re-cluster on the next update
	}

	setCurrent(path) {
		this.current = path;
	}

	pinTexture(count) {
		let texture = this.pinTextures.get(count);
		if (!texture) {
			texture = makePinTexture(count, this.accent);
			this.pinTextures.set(count, texture);
		}
		return texture;
	}

	// Greedy clustering: a pin joins the first cluster within the merge angle.
	cluster() {
		for (const cluster of this.clusters) {
			this.pins.remove(cluster.mesh);
			cluster.mesh.material.dispose();
		}
		const clusters = [];
		for (const { item, coordinates } of this.items) {
			const near = clusters.find((cluster) => angularDistance(cluster, coordinates) < this.mergeAngle);
			if (near) {
				near.items.push(item);
				near.vector.add(latLonToVector3(coordinates.lat, coordinates.lon));
				Object.assign(near, vector3ToLatLon(near.vector));
			} else {
				clusters.push({ items: [item], vector: latLonToVector3(coordinates.lat, coordinates.lon), ...coordinates });
			}
		}

		pinGeometry ??= new THREE.PlaneGeometry(2, 2);
		for (const cluster of clusters) {
			cluster.spread = Math.max(...cluster.items.map((item) => angularDistance(cluster, itemCoordinates(item))));
			cluster.group = cluster.items.length > 1 && cluster.spread < GROUP_SPREAD;
			const mesh = new THREE.Mesh(pinGeometry, new THREE.MeshBasicMaterial({
				map: this.pinTexture(cluster.items.length),
				transparent: true,
				depthTest: false,
				depthWrite: false,
				opacity: this.opacity,
			}));
			mesh.renderOrder = 4;
			mesh.position.copy(cluster.vector).normalize(); // on the ground: pins skip the depth test
			mesh.userData = { hover: 0, hoverT: 0, cluster };
			cluster.mesh = mesh;
			this.pins.add(mesh);
		}
		this.clusters = clusters;
		this.clusterAltitude = this.view.altitude;
		this.onCluster?.(clusters);
	}

	get visiblePins() {
		return this.clusters.filter((cluster) => cluster.mesh.visible).map((cluster) => cluster.mesh);
	}

	get hoveredCluster() {
		return this.clusters.find((cluster) => cluster.mesh.visible && cluster.mesh.userData.hover > 0) ?? null;
	}

	/**
	 * What selecting a pin does: clusters that split when zoomed in are zoomed into (returns null);
	 * single photos and photos too close together to ever split are returned for the host to open.
	 */
	selectCluster(cluster) {
		const altitude = this.splitAltitude(cluster);
		if (altitude === null) return cluster;
		this.flyTo({ lat: cluster.lat, lon: cluster.lon, altitude });
		return null;
	}

	// Altitude at which a cluster's pins come apart, or null when it is one photo / one place.
	splitAltitude(cluster) {
		if (cluster.items.length < 2 || cluster.group) return null;
		const factor = this.mergeAngle / this.view.altitude; // merge angle per unit altitude
		const altitude = Math.min(this.view.altitude * 0.6, (0.8 * cluster.spread) / factor);
		return altitude >= this.minAltitude ? altitude : null;
	}

	// --- View --------------------------------------------------------------

	get minAltitude() {
		const detail = this.tiles.available
			? this.tiles.minAltitude(this.pixelsPerRadian, this.view.lat)
			: this.pixelsPerRadian / (EARTH_TEXTURE_PX_PER_RADIAN * OFFLINE_MAGNIFICATION);
		return Math.min(this.maxAltitude, Math.max(detail, this.hostMinAltitude));
	}

	setView({ lat = this.view.lat, lon = this.view.lon, altitude = this.view.altitude }) {
		this.view.lat = THREE.MathUtils.clamp(lat, -MAX_LAT, MAX_LAT);
		this.view.lon = wrapLon(lon);
		this.view.altitude = THREE.MathUtils.clamp(altitude, this.minAltitude, this.maxAltitude);
		this.applyView();
	}

	applyView() {
		this.place?.(this);
		this.body.rotation.set(this.view.lat * DEG, -Math.PI / 2 - this.view.lon * DEG, 0, 'XYZ');
		this.updateMatrixWorld(true);
	}

	// Opens where the globe was left last time, else on the current photo.
	restoreView(path = this.current) {
		let saved = null;
		try {
			saved = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY));
		} catch { /* no storage */ }
		if (saved && [saved.lat, saved.lon, saved.altitude].every(Number.isFinite)) this.setView(saved);
		else this.frame(path);
	}

	saveView() {
		const json = JSON.stringify(this.view);
		if (json === this.savedView) return;
		this.savedView = json;
		try {
			localStorage.setItem(VIEW_STORAGE_KEY, json);
		} catch { /* no storage: start on the current photo next time */ }
	}

	// Starting view: on the current photo when it has a position, else around all pins.
	frame(path = this.current) {
		const own = this.items.find((entry) => entry.item.path === path)?.coordinates;
		if (own) {
			this.setView({ ...own, altitude: 1.2 });
			return;
		}
		if (this.items.length === 0) {
			this.setView({ lat: 20, lon: 0, altitude: this.maxAltitude });
			return;
		}
		const sum = new THREE.Vector3();
		for (const { coordinates } of this.items) sum.add(latLonToVector3(coordinates.lat, coordinates.lon));
		const center = vector3ToLatLon(sum);
		const spread = Math.max(...this.items.map(({ coordinates }) => angularDistance(center, coordinates)));
		this.setView({ ...center, altitude: this.items.length > 1 ? Math.max(0.4, spread * 3) : 1.2 });
	}

	rotateBy(dLat, dLon) {
		this.flight = null;
		this.setView({ lat: this.view.lat + dLat, lon: this.view.lon + dLon });
	}

	zoomBy(factor) {
		this.flight = null;
		this.setView({ altitude: this.view.altitude * factor });
	}

	// Zooms while keeping the point under `getRay()` in place (the ray is re-read after the zoom).
	zoomAt(factor, getRay) {
		this.flight = null;
		const anchor = this.pointUnder(getRay());
		this.setView({ altitude: this.view.altitude * factor });
		if (anchor) this.pullTowards(anchor, getRay());
	}

	flyTo(target, duration = FLY_DURATION) {
		const from = { ...this.view };
		const to = {
			lat: target.lat ?? from.lat,
			lon: from.lon + wrapLon((target.lon ?? from.lon) - from.lon),
			altitude: THREE.MathUtils.clamp(target.altitude ?? from.altitude, this.minAltitude, this.maxAltitude),
		};
		this.velocity.lat = 0;
		this.velocity.lon = 0;
		return new Promise((resolve) => {
			this.flight?.resolve();
			this.flight = { from, to, t: 0, duration, resolve };
		});
	}

	// --- Dragging ----------------------------------------------------------

	// Point on the globe (body coordinates) hit by a world-space ray; with `nearest`, the
	// closest point on the sphere when the ray misses it.
	pointUnder(ray, nearest = false) {
		const center = this.body.getWorldPosition(new THREE.Vector3());
		const radius = this.getWorldScale(new THREE.Vector3()).x;
		const hit = ray.intersectSphere(new THREE.Sphere(center, radius), new THREE.Vector3());
		let point = hit;
		if (!point) {
			if (!nearest) return null;
			point = ray.closestPointToPoint(center, new THREE.Vector3()).sub(center).setLength(radius).add(center);
		}
		return vector3ToLatLon(this.body.worldToLocal(point));
	}

	// Turns the globe so `anchor` (lat/lon) moves under the ray.
	pullTowards(anchor, ray) {
		const now = this.pointUnder(ray, true);
		if (!now) return;
		const dLat = now.lat - anchor.lat;
		const dLon = wrapLon(now.lon - anchor.lon);
		this.setView({ lat: this.view.lat - dLat, lon: this.view.lon - dLon });
		this.dragDelta.lat -= dLat;
		this.dragDelta.lon -= dLon;
	}

	beginDrag(ray) {
		const anchor = this.pointUnder(ray);
		if (!anchor) return false;
		this.flight?.resolve();
		this.flight = null;
		this.dragAnchor = anchor;
		this.velocity.lat = 0;
		this.velocity.lon = 0;
		return true;
	}

	drag(ray) {
		if (this.dragAnchor) this.pullTowards(this.dragAnchor, ray);
	}

	endDrag() {
		this.dragAnchor = null;
	}

	get dragging() {
		return !!this.dragAnchor;
	}

	// --- Frame -------------------------------------------------------------

	/**
	 * @param viewer           camera position in world space
	 * @param pixelsPerRadian  display pixels per radian of view angle (picks the tile level)
	 * @param pinPixels        on-screen pin radius
	 */
	update(dt, { viewer, pixelsPerRadian = this.pixelsPerRadian, pinPixels = 10 }) {
		this.pixelsPerRadian = pixelsPerRadian;
		const view = this.view;

		if (this.flight) {
			const flight = this.flight;
			flight.t = Math.min(1, flight.t + dt / flight.duration);
			const p = easeInOutCubic(flight.t);
			// Zoom out a little on long flights, like a plane rather than a slide.
			const hop = 1 + angularDistance(flight.from, flight.to) * Math.sin(Math.PI * p);
			view.lat = THREE.MathUtils.lerp(flight.from.lat, flight.to.lat, p);
			view.lon = wrapLon(THREE.MathUtils.lerp(flight.from.lon, flight.to.lon, p));
			view.altitude = Math.exp(THREE.MathUtils.lerp(Math.log(flight.from.altitude), Math.log(flight.to.altitude), p)) * hop;
			if (flight.t >= 1) {
				this.flight = null;
				flight.resolve();
			}
		} else if (this.dragging) {
			const blend = 1 - Math.exp(-dt * 20);
			if (dt > 0) {
				this.velocity.lat += (this.dragDelta.lat / dt - this.velocity.lat) * blend;
				this.velocity.lon += (this.dragDelta.lon / dt - this.velocity.lon) * blend;
			}
		} else if (Math.abs(this.velocity.lat) + Math.abs(this.velocity.lon) > 1e-4 * view.altitude) {
			view.lat += this.velocity.lat * dt;
			view.lon += this.velocity.lon * dt;
			const damping = Math.exp(-dt * INERTIA_DAMPING);
			this.velocity.lat *= damping;
			this.velocity.lon *= damping;
		}
		this.dragDelta.lat = 0;
		this.dragDelta.lon = 0;
		this.saveTime = (this.saveTime ?? 0) + dt;
		if (this.saveTime > VIEW_SAVE_INTERVAL) {
			this.saveTime = 0;
			this.saveView();
		}
		// Also pulls the altitude back up when tiles turn out to be unavailable.
		if (!this.flight) this.setView(view);
		else this.applyView();

		// Fade centre: the focus point on the surface, in world space.
		this.body.localToWorld(latLonToVector3(view.lat, view.lon, 1, this.uniforms.fadeCenter.value));
		this.tiles.update(view, pixelsPerRadian);

		const pinAngle = pinPixels / pixelsPerRadian;
		this.mergeAngle = MERGE_FACTOR * pinAngle * view.altitude;
		const ratio = view.altitude / this.clusterAltitude;
		if (!this.clusterAltitude || ratio > RECLUSTER_RATIO || ratio < 1 / RECLUSTER_RATIO) this.cluster();
		this.updatePins(dt, viewer, pinAngle);
	}

	updatePins(dt, viewer, pinAngle) {
		const scale = this.getWorldScale(new THREE.Vector3()).x;
		const world = new THREE.Vector3();
		const normal = new THREE.Vector3();
		const toViewer = new THREE.Vector3();
		const fade = this.uniforms;
		const hoverEase = 1 - Math.exp(-dt * 18);
		for (const { mesh, items } of this.clusters) {
			mesh.getWorldPosition(world);
			normal.copy(world).sub(this.body.getWorldPosition(toViewer)).normalize();
			toViewer.copy(viewer).sub(world);
			const distance = toViewer.length();
			const facing = normal.dot(toViewer.normalize()) > 0.02;
			const inWindow = world.distanceTo(fade.fadeCenter.value) < fade.fadeRadius.value - fade.fadeWidth.value * 0.5;
			mesh.visible = facing && inWindow && this.opacity > 0.01;
			if (!mesh.visible) continue;
			const data = mesh.userData;
			data.hoverT += ((data.hover > 0 ? 1 : 0) - data.hoverT) * hoverEase;
			const size = items.length > 1 ? CLUSTER_PIN_SCALE : 1;
			mesh.scale.setScalar(((distance * pinAngle * size) / scale) * (1 + 0.35 * data.hoverT));
			mesh.lookAt(viewer);
			mesh.material.opacity = this.opacity;
		}
	}

	setOpacity(opacity) {
		this.opacity = opacity;
		this.uniforms.globeOpacity.value = opacity;
		this.visible = opacity > 0.001;
	}

	dispose() {
		this.disposed = true;
		this.flight?.resolve();
		this.tiles.dispose();
		this.earth.geometry.dispose();
		this.earth.material.dispose();
		this.earthTexture.dispose();
		for (const cluster of this.clusters) cluster.mesh.material.dispose();
		for (const texture of this.pinTextures.values()) texture.dispose();
		this.pinTextures.clear();
		this.clusters = [];
	}
}
