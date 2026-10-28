import * as THREE from 'three';
import { Globe } from './vr/globe.js';
import { itemCoordinates } from './vr/geo.js';
import { PreviewOrb } from './vr/preview-orb.js';

// Desktop map: the shared globe in the map dialog, with mouse / touch / keyboard controls.
// Created when the dialog opens and destroyed when it closes, so it holds no GPU memory otherwise.

const ACCENT = '#43cea2';
const FOV = 40;
const PIN_PIXELS = 10;
const ORB_PIXELS = 46; // preview orb radius on screen
const ORB_LIFT = 70; // px between the pin and the orb centre
const DRAG_THRESHOLD = 5; // px before a press on a pin becomes a drag
const KEY_ROTATE = 8; // degrees per key press at altitude 1
const FOCUS_ALTITUDE = 0.3; // zoom when going to a photo (about a region), unless already closer

function makeHaloTexture() {
	const size = 256;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.36, size / 2, size / 2, size / 2);
	gradient.addColorStop(0, 'rgba(110, 180, 255, 0.55)');
	gradient.addColorStop(0.25, 'rgba(80, 150, 255, 0.18)');
	gradient.addColorStop(1, 'rgba(60, 120, 255, 0)');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, size, size);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

export class GlobeView {
	/**
	 * @param stage        element the canvas goes into
	 * @param card         { root, title, description, count, action } elements of the photo card
	 * @param attribution  element showing the tile attribution
	 * @param zoom         { in, out, locate } map buttons
	 * @param onOpen       (path) => void, opens a photo
	 */
	constructor({ stage, card, attribution, zoom, items, current, config = {}, resolveUrl, onOpen }) {
		this.stage = stage;
		this.card = card;
		this.attribution = attribution;
		this.zoom = zoom;
		this.onOpen = onOpen;
		this.pointers = new Map(); // pointerId -> { x, y }
		this.press = null;
		this.hovered = null;
		this.selected = null; // tapped pin (touch has no hover)
		this.cardItem = null;
		this.lastTime = 0;
		this.destroyed = false;

		const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setClearColor(0x000000, 0);
		this.renderer = renderer;
		renderer.domElement.className = 'globe-canvas';
		stage.prepend(renderer.domElement);

		this.scene = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 10);
		this.raycaster = new THREE.Raycaster();

		this.globe = new Globe({
			items,
			current,
			accent: ACCENT,
			tileUrl: config.globeTileUrl || '',
			tileMaxZoom: config.globeTileMaxZoom,
			tileCache: 320,
			maxAltitude: 3.2,
			place: (globe) => this.placeCamera(globe.view.altitude),
		});
		this.scene.add(this.globe);

		this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeHaloTexture(), depthWrite: false, transparent: true }));
		this.halo.scale.setScalar(2.9);
		this.halo.renderOrder = -1;
		this.scene.add(this.halo);

		this.orb = new PreviewOrb({ radius: 1, accent: ACCENT, resolveUrl });
		this.scene.add(this.orb);

		this.resize();
		this.globe.restoreView(current);
		this.updateLocate();
		this.attribution.textContent = config.globeTileAttribution || '';

		this.bindEvents();
		this.stage.globeView = this; // test hook
		renderer.setAnimationLoop((time) => this.loop(time));
	}

	get pixelsPerRadian() {
		return (this.stage.clientHeight || 1) / 2 / Math.tan((FOV / 2) * (Math.PI / 180));
	}

	placeCamera(altitude) {
		const camera = this.camera;
		camera.position.set(0, 0, 1 + altitude);
		camera.lookAt(0, 0, 0);
		camera.near = Math.max(altitude * 0.05, 1e-6);
		camera.far = altitude + 2.5;
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld();
	}

	resize() {
		const width = this.stage.clientWidth || 1;
		const height = this.stage.clientHeight || 1;
		this.renderer.setSize(width, height, false);
		this.camera.aspect = width / height;
		this.globe.pixelsPerRadian = this.pixelsPerRadian;
		this.placeCamera(this.globe.view.altitude);
	}

	setItems(items, current) {
		this.globe.setItems(items, current);
		this.updateLocate();
	}

	updateLocate() {
		this.zoom.locate.disabled = !this.coordinatesOf(this.globe.current);
	}

	coordinatesOf(path) {
		return itemCoordinates(this.globe.items.find((entry) => entry.item.path === path)?.item);
	}

	// Flies to a photo and previews its pin, as if it had been tapped.
	async focus(path) {
		const coordinates = this.coordinatesOf(path);
		if (!coordinates) return;
		this.selected = null;
		await this.globe.flyTo({ ...coordinates, altitude: Math.min(this.globe.view.altitude, FOCUS_ALTITUDE) });
		if (this.destroyed) return;
		this.globe.update(0, { viewer: this.camera.position, pixelsPerRadian: this.pixelsPerRadian, pinPixels: PIN_PIXELS });
		this.selected = this.globe.clusters.find((cluster) => cluster.items.some((item) => item.path === path)) ?? null;
	}

	// --- Input -------------------------------------------------------------

	bindEvents() {
		const canvas = this.renderer.domElement;
		this.listeners = [
			[canvas, 'pointerdown', (event) => this.onPointerDown(event)],
			[canvas, 'pointermove', (event) => this.onPointerMove(event)],
			[canvas, 'pointerup', (event) => this.onPointerUp(event)],
			[canvas, 'pointercancel', (event) => this.onPointerUp(event, true)],
			[canvas, 'pointerleave', () => this.setHovered(null)],
			[canvas, 'wheel', (event) => this.onWheel(event), { passive: false }],
			[canvas, 'dblclick', (event) => this.globe.zoomAt(0.5, () => this.rayAt(event))],
			[this.stage.closest('dialog') || this.stage, 'keydown', (event) => this.onKeyDown(event)],
			[this.zoom.in, 'click', () => this.globe.flyTo({ altitude: this.globe.view.altitude * 0.5 }, 0.35)],
			[this.zoom.out, 'click', () => this.globe.flyTo({ altitude: this.globe.view.altitude * 2 }, 0.35)],
			[this.zoom.locate, 'click', () => this.focus(this.globe.current)],
		];
		for (const [target, type, listener, options] of this.listeners) target.addEventListener(type, listener, options);
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(this.stage);
	}

	rayAt({ clientX, clientY }) {
		const rect = this.renderer.domElement.getBoundingClientRect();
		const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
		this.raycaster.setFromCamera(ndc, this.camera);
		return this.raycaster.ray.clone();
	}

	pinAt(event) {
		this.rayAt(event);
		return this.raycaster.intersectObjects(this.globe.visiblePins, false)[0]?.object.userData.cluster ?? null;
	}

	// The preview orb opens its photo as well.
	orbAt(event) {
		if (!this.orb.visible || this.orb.opacity < 0.5) return false;
		this.rayAt(event);
		return this.raycaster.intersectObject(this.orb.sphere, false).length > 0;
	}

	onPointerDown(event) {
		this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		this.renderer.domElement.setPointerCapture(event.pointerId);
		if (this.pointers.size === 2) {
			// Second finger: pinch instead of dragging.
			this.globe.endDrag();
			this.press = null;
			this.pinch = this.pinchState();
			return;
		}
		if (this.pointers.size > 2) return;
		this.pointerType = event.pointerType;
		const cluster = this.pinAt(event);
		const orb = !cluster && this.orbAt(event);
		this.press = { x: event.clientX, y: event.clientY, cluster, orb, type: event.pointerType, dragging: false };
		if (!cluster && !orb) this.startDrag(event);
	}

	startDrag(event) {
		this.press.dragging = this.globe.beginDrag(this.rayAt(event));
		this.renderer.domElement.classList.toggle('dragging', this.press.dragging);
	}

	onPointerMove(event) {
		const pointer = this.pointers.get(event.pointerId);
		if (pointer) {
			pointer.x = event.clientX;
			pointer.y = event.clientY;
		}
		if (this.pinch && this.pointers.size === 2) {
			const now = this.pinchState();
			this.globe.zoomAt(this.pinch.distance / Math.max(now.distance, 1), () => this.rayAt(now.center));
			this.pinch = now;
			return;
		}
		const press = this.press;
		if (press && !press.dragging && Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_THRESHOLD) {
			press.cluster = null;
			press.orb = false;
			this.startDrag(event);
		}
		if (press?.dragging) {
			this.globe.drag(this.rayAt(event));
			return;
		}
		if (event.pointerType === 'mouse' && !press) {
			this.pointerType = 'mouse';
			// Moving from the pin up onto its orb keeps the preview.
			this.setHovered(this.pinAt(event) ?? (this.orbAt(event) ? this.hovered : null));
		}
	}

	onPointerUp(event, cancelled = false) {
		this.pointers.delete(event.pointerId);
		if (this.pinch) {
			if (this.pointers.size < 2) this.pinch = null;
			return;
		}
		const press = this.press;
		this.press = null;
		this.globe.endDrag();
		this.renderer.domElement.classList.remove('dragging');
		if (!press || cancelled) return;
		if (press.cluster) this.onPinClick(press.cluster, press.type);
		else if (press.orb) this.openItem(this.orb.item);
		else if (!press.dragging || Math.hypot(event.clientX - press.x, event.clientY - press.y) <= DRAG_THRESHOLD) this.selected = null;
	}

	pinchState() {
		const [a, b] = [...this.pointers.values()];
		return { distance: Math.hypot(a.x - b.x, a.y - b.y), center: { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 } };
	}

	onPinClick(cluster, pointerType) {
		if (!this.globe.selectCluster(cluster)) {
			this.selected = null; // zooming into the cluster
			return;
		}
		// With a mouse the preview is already showing; a first tap only previews.
		if (pointerType === 'mouse' || this.selected === cluster) this.openItem(this.previewItem(cluster));
		else this.selected = cluster;
	}

	// The photo the orb shows for this pin (groups take turns), else its first photo.
	previewItem(cluster) {
		const items = this.orb.items;
		const showing = items.length === cluster.items.length && items.every((item, i) => item === cluster.items[i]);
		return (showing && this.orb.item) || cluster.items[0];
	}

	openItem(item) {
		if (item) this.onOpen?.(item.path);
	}

	onWheel(event) {
		event.preventDefault();
		const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
		this.globe.zoomAt(Math.exp(THREE.MathUtils.clamp(delta, -200, 200) * 0.002), () => this.rayAt(event));
	}

	onKeyDown(event) {
		if (event.target.closest?.('button, input, textarea, select')) return;
		const step = KEY_ROTATE * Math.min(1, this.globe.view.altitude);
		const actions = {
			ArrowLeft: () => this.globe.rotateBy(0, -step),
			ArrowRight: () => this.globe.rotateBy(0, step),
			ArrowUp: () => this.globe.rotateBy(step, 0),
			ArrowDown: () => this.globe.rotateBy(-step, 0),
			'+': () => this.globe.zoomBy(0.7),
			'=': () => this.globe.zoomBy(0.7),
			'-': () => this.globe.zoomBy(1 / 0.7),
		};
		const action = actions[event.key];
		if (!action) return;
		event.preventDefault();
		action();
	}

	setHovered(cluster) {
		if (this.hovered === cluster) return;
		if (this.hovered) this.hovered.mesh.userData.hover = 0;
		this.hovered = cluster;
		if (cluster) cluster.mesh.userData.hover = 1;
		this.renderer.domElement.classList.toggle('over-pin', !!cluster);
	}

	// --- Frame -------------------------------------------------------------

	loop(time) {
		if (this.destroyed) return;
		const dt = this.lastTime ? Math.min((time - this.lastTime) / 1000, 0.1) : 0;
		this.lastTime = time;
		const globe = this.globe;

		// Pins can be re-created when the clusters change; keep hover / selection on the new ones.
		if (this.hovered && !globe.clusters.includes(this.hovered)) this.setHovered(null);
		if (this.selected && !globe.clusters.includes(this.selected)) this.selected = null;

		globe.update(dt, { viewer: this.camera.position, pixelsPerRadian: this.pixelsPerRadian, pinPixels: PIN_PIXELS });
		this.halo.material.opacity = THREE.MathUtils.clamp((globe.view.altitude - 0.3) / 0.8, 0, 1);

		const focus = this.hovered ?? this.selected;
		const visible = focus?.mesh.visible ? focus : null;
		if (visible) this.orb.show(visible.items);
		else this.orb.hide();
		if (visible) this.placeOrb(visible);
		this.orb.update(dt, this.camera.position);
		this.updateCard(visible);

		this.stage.dataset.ready = globe.ready ? '1' : '0';
		this.stage.dataset.tiles = String(globe.tiles.visibleCount);
		this.stage.dataset.tileState = !globe.tiles.enabled ? 'off' : globe.tiles.offline ? 'offline' : 'online';
		this.attribution.hidden = globe.tiles.visibleCount === 0 || !this.attribution.textContent;

		this.renderer.render(this.scene, this.camera);
	}

	screenPosition(world) {
		const ndc = world.clone().project(this.camera);
		const rect = this.renderer.domElement.getBoundingClientRect();
		return { x: (ndc.x + 1) / 2 * rect.width, y: (1 - ndc.y) / 2 * rect.height, left: rect.left, top: rect.top };
	}

	// The orb floats above the pin, a fixed number of pixels in size.
	placeOrb(cluster) {
		const pin = cluster.mesh.getWorldPosition(new THREE.Vector3());
		const distance = pin.distanceTo(this.camera.position);
		const perPixel = distance / this.pixelsPerRadian;
		const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
		const toCamera = this.camera.position.clone().sub(pin).normalize();
		this.orb.position.copy(pin).addScaledVector(up, ORB_LIFT * perPixel).addScaledVector(toCamera, ORB_PIXELS * perPixel);
		this.orb.scale.setScalar(ORB_PIXELS * perPixel);
	}

	updateCard(cluster) {
		const { root, title, description, count, action } = this.card;
		const item = cluster ? this.orb.item : null;
		if (!item) {
			root.hidden = true;
			this.cardItem = null;
			return;
		}
		if (item !== this.cardItem) {
			this.cardItem = item;
			title.textContent = item.name || decodeURIComponent(item.path.split('/').pop());
			description.textContent = item.description || '';
			description.hidden = !item.description;
		}
		count.textContent = cluster.items.length > 1 ? `${cluster.items.indexOf(item) + 1} of ${cluster.items.length} here` : '';
		const touch = this.pointerType && this.pointerType !== 'mouse';
		if (this.globe.splitAltitude(cluster) !== null) action.textContent = touch ? 'Tap the pin to zoom in' : 'Click the pin to zoom in';
		else action.textContent = touch ? 'Tap again to open' : 'Click to open';
		root.hidden = false;

		// Below the pin, kept inside the stage.
		const { x, y } = this.screenPosition(cluster.mesh.getWorldPosition(new THREE.Vector3()));
		const width = root.offsetWidth;
		const height = root.offsetHeight;
		const stageWidth = this.stage.clientWidth;
		const stageHeight = this.stage.clientHeight;
		const left = THREE.MathUtils.clamp(x - width / 2, 8, Math.max(8, stageWidth - width - 8));
		const below = y + PIN_PIXELS * 2 + 6;
		const top = below + height > stageHeight - 8 ? Math.max(8, y - ORB_LIFT - ORB_PIXELS - height - 12) : below;
		root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
	}

	// Test hook: screen positions of the pins, in client coordinates.
	pinPositions() {
		return this.globe.clusters.map((cluster) => {
			const { x, y, left, top } = this.screenPosition(cluster.mesh.getWorldPosition(new THREE.Vector3()));
			return { x: x + left, y: y + top, visible: cluster.mesh.visible, paths: cluster.items.map((item) => item.path) };
		});
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.renderer.setAnimationLoop(null);
		for (const [target, type, listener, options] of this.listeners) target.removeEventListener(type, listener, options);
		this.resizeObserver.disconnect();
		delete this.stage.globeView;
		for (const key of ['ready', 'tiles', 'tileState']) delete this.stage.dataset[key];
		this.card.root.hidden = true;
		this.attribution.hidden = true;
		this.globe.saveView();
		this.globe.dispose();
		this.orb.dispose();
		this.halo.material.map.dispose();
		this.halo.material.dispose();
		this.renderer.dispose();
		this.renderer.forceContextLoss();
		this.renderer.domElement.remove();
	}
}
