import * as THREE from 'three';
import { Globe } from './globe.js';
import { PreviewOrb } from './preview-orb.js';
import { TextLabel } from './text-label.js';

// The globe in VR: floats where the photo orb normally is, with a preview orb above the
// pointed-at pin and Gallery / zoom buttons below. Lives in the viewer's follow rig.

const DISTANCE = 0.85; // from the viewer to the globe's front surface
const CENTER_Y = -0.02;
const MAX_RADIUS = 400; // m, keeps a zoomed-in globe inside the camera's far plane (500 m)
const MAX_ALTITUDE = 3; // the whole Earth, ~0.28 m radius
const PIXELS_PER_RADIAN = 1300; // about the Quest 3 display density
const PIN_PIXELS = 14;
const FADE = { radius: 0.55, width: 0.15 }; // zoomed in, the map fades out beyond this (m)
const CONTROLS_Y = -0.34;
const CONTROLS_Z = -0.95;
const ORB_RADIUS = 0.06;
const ORB_LIFT = 0.1;
const PREVIEW_LINGER = 0.4; // s the preview stays after the ray leaves its pin
const STICK_DEADZONE = 0.15;
const STICK_ROTATE = 45; // degrees per second at altitude 1
const STICK_ZOOM = 1.6;

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const COLORS = {
	surface: '#1d2128',
	border: 'rgba(255, 255, 255, 0.14)',
	text: '#e8eaed',
};

function makeButtonTexture(width, height, draw) {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = COLORS.surface;
	ctx.strokeStyle = COLORS.border;
	ctx.lineWidth = 4;
	ctx.beginPath();
	ctx.roundRect(2, 2, width - 4, height - 4, (height - 4) / 2);
	ctx.fill();
	ctx.stroke();
	ctx.strokeStyle = COLORS.text;
	ctx.fillStyle = COLORS.text;
	ctx.lineWidth = 9;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	draw(ctx);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	return texture;
}

export class VRGlobePanel {
	constructor({ items = [], accent = '#43cea2', config = {}, resolveUrl, onSelect, onBack }) {
		this.items = items;
		this.accent = accent;
		this.config = config;
		this.resolveUrl = resolveUrl;
		this.onSelect = onSelect;
		this.onBack = onBack;
		this.current = null;

		this.panel = new THREE.Group();
		this.panel.visible = false;
		this.alpha = 0;
		this.targetAlpha = 0;
		this.globe = null; // created on show, disposed once hidden (frees the Earth texture)
		this.orb = null;
		this.previewCluster = null;
		this.previewAge = 0;

		this.label = new TextLabel({ height: 0.032, maxWidth: 0.42 });
		this.hint = new TextLabel({ height: 0.026, maxWidth: 0.8, fontSize: 34 });
		this.hint.position.set(0, CONTROLS_Y - 0.055, CONTROLS_Z);
		this.attribution = new TextLabel({ height: 0.018, maxWidth: 0.6, fontSize: 30 });
		this.attribution.position.set(0, CONTROLS_Y - 0.095, CONTROLS_Z);
		this.attribution.setText(config.globeTileAttribution || '');
		for (const label of [this.hint, this.attribution]) label.rotation.x = -Math.atan2(-label.position.y, -label.position.z);
		this.panel.add(this.label, this.hint, this.attribution);

		this.buildControls();
	}

	get visible() {
		return this.targetAlpha > 0;
	}

	buildControls() {
		const button = (texture, width, height, x, onActivate) => {
			const mesh = new THREE.Mesh(
				new THREE.PlaneGeometry(width, height),
				// No depth test: the zoomed-in globe's faded edge may be in front of them.
				new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
			);
			mesh.position.set(x, CONTROLS_Y, CONTROLS_Z);
			mesh.rotation.x = -Math.atan2(-CONTROLS_Y, -CONTROLS_Z); // tilted towards the viewer
			mesh.renderOrder = 6;
			mesh.userData = { hover: 0, hoverT: 0, onActivate };
			this.panel.add(mesh);
			return mesh;
		};
		const accent = this.accent;
		const back = makeButtonTexture(384, 116, (ctx) => {
			ctx.strokeStyle = accent;
			ctx.beginPath();
			ctx.moveTo(78, 34);
			ctx.lineTo(54, 58);
			ctx.lineTo(78, 82);
			ctx.stroke();
			ctx.font = `600 44px ${FONT}`;
			ctx.textBaseline = 'middle';
			ctx.fillText('Gallery', 108, 60);
		});
		const zoom = (plus) => makeButtonTexture(128, 128, (ctx) => {
			ctx.beginPath();
			ctx.moveTo(40, 64);
			ctx.lineTo(88, 64);
			if (plus) {
				ctx.moveTo(64, 40);
				ctx.lineTo(64, 88);
			}
			ctx.stroke();
		});
		this.buttons = [
			button(back, 0.15, 0.045, -0.12, () => this.onBack?.()),
			button(zoom(false), 0.045, 0.045, 0.07, () => this.zoom(2)),
			button(zoom(true), 0.045, 0.045, 0.13, () => this.zoom(0.5)),
		];
	}

	createGlobe() {
		const globe = new Globe({
			items: this.items,
			current: this.current,
			accent: this.accent,
			tileUrl: this.config.globeTileUrl || '',
			tileMaxZoom: this.config.globeTileMaxZoom,
			tileCache: 192, // ~65 MB of GPU memory next to the panorama
			fade: FADE,
			minAltitude: DISTANCE / MAX_RADIUS,
			maxAltitude: MAX_ALTITUDE,
			pixelsPerRadian: PIXELS_PER_RADIAN,
			// Zooming scales the globe up while its front surface stays at the same distance.
			place: (g) => {
				const radius = DISTANCE / g.view.altitude;
				g.scale.setScalar(radius);
				g.position.set(0, CENTER_Y, -(DISTANCE + radius));
			},
		});
		Object.assign(globe.earth.userData, {
			onPress: (ray) => globe.beginDrag(ray),
			onDrag: (ray) => globe.drag(ray),
			onRelease: () => globe.endDrag(),
		});
		globe.onCluster = (clusters) => {
			for (const cluster of clusters) cluster.mesh.userData.onActivate = () => this.selectCluster(cluster);
		};
		this.globe = globe;
		this.panel.add(globe);
		this.orb = new PreviewOrb({ radius: ORB_RADIUS, accent: this.accent, resolveUrl: this.resolveUrl });
		this.panel.add(this.orb);
	}

	disposeGlobe() {
		if (!this.globe) return;
		this.panel.remove(this.globe, this.orb);
		this.globe.dispose();
		this.orb.dispose();
		this.globe = null;
		this.orb = null;
		this.previewCluster = null;
	}

	show(current, { handsOnly = false } = {}) {
		this.current = current;
		if (!this.globe) this.createGlobe();
		this.globe.setItems(this.items, current);
		this.globe.restoreView(current);
		const separator = { text: '   ·   ', style: 'muted' };
		this.hint.setParts(handsOnly
			? [{ text: 'Pinch', style: 'accent' }, ' drag to turn, a pin to open']
			: [{ text: 'Trigger', style: 'accent' }, ' drag / open', separator, { text: 'Stick', style: 'accent' }, ' zoom & turn']);
		this.targetAlpha = 1;
		this.panel.visible = true;
	}

	hide() {
		this.targetAlpha = 0;
		this.globe?.endDrag();
		this.globe?.saveView();
	}

	setCurrent(path) {
		this.current = path;
		this.globe?.setCurrent(path);
	}

	getInteractives() {
		if (!this.panel.visible || this.alpha < 0.6 || !this.globe) return [];
		return [...this.globe.visiblePins, this.globe.earth, ...this.buttons];
	}

	// Pins of several photos zoom in until they split; otherwise open the previewed photo.
	selectCluster(cluster) {
		const target = this.globe?.selectCluster(cluster);
		if (!target) return;
		const item = (this.previewCluster === target && this.orb.item) || target.items[0];
		this.onSelect?.(item.path);
	}

	zoom(factor) {
		const globe = this.globe;
		if (globe) globe.flyTo({ altitude: globe.view.altitude * factor }, 0.35);
	}

	// Thumbstick: left / right turns the globe, forward / back zooms.
	stick(x, y, dt) {
		const globe = this.globe;
		if (!globe || globe.dragging) return;
		if (Math.abs(x) > STICK_DEADZONE) globe.rotateBy(0, x * dt * STICK_ROTATE * Math.min(globe.view.altitude, 2));
		if (Math.abs(y) > STICK_DEADZONE) globe.zoomBy(Math.exp(y * dt * STICK_ZOOM));
	}

	update(dt, viewer) {
		this.alpha += (this.targetAlpha - this.alpha) * (1 - Math.exp(-dt * 10));
		if (this.targetAlpha === 0 && this.alpha < 0.01) {
			this.alpha = 0;
			this.panel.visible = false;
			this.disposeGlobe();
			return;
		}
		if (!this.panel.visible || !this.globe) return;

		const globe = this.globe;
		globe.setOpacity(this.alpha);
		globe.update(dt, { viewer, pixelsPerRadian: PIXELS_PER_RADIAN, pinPixels: PIN_PIXELS });
		this.updatePreview(dt, viewer);

		const hoverEase = 1 - Math.exp(-dt * 18);
		for (const button of this.buttons) {
			const data = button.userData;
			data.hoverT += ((data.hover > 0 ? 1 : 0) - data.hoverT) * hoverEase;
			button.scale.setScalar(1 + 0.1 * data.hoverT);
			button.material.opacity = this.alpha * (0.85 + 0.15 * data.hoverT);
		}
		this.hint.setOpacity(this.alpha * 0.9);
		this.attribution.setOpacity(globe.tiles.visibleCount > 0 ? this.alpha * 0.8 : 0);
	}

	updatePreview(dt, viewer) {
		const globe = this.globe;
		const hovered = this.targetAlpha > 0 ? globe.hoveredCluster : null;
		if (hovered) {
			this.previewCluster = hovered;
			this.previewAge = 0;
		} else if (this.previewCluster) {
			this.previewAge += dt;
			const gone = !globe.clusters.includes(this.previewCluster) || !this.previewCluster.mesh.visible;
			if (gone || this.previewAge > PREVIEW_LINGER || this.targetAlpha === 0) this.previewCluster = null;
		}

		const cluster = this.previewCluster;
		const orb = this.orb;
		if (cluster) {
			orb.show(cluster.items);
			// Above the pin, pulled a little towards the viewer (panel coordinates, viewer near the origin).
			const pin = this.panel.worldToLocal(cluster.mesh.getWorldPosition(new THREE.Vector3()));
			const towards = pin.clone().negate().normalize();
			orb.position.copy(pin).add(new THREE.Vector3(0, ORB_LIFT, 0)).addScaledVector(towards, 0.06);
		} else {
			orb.hide();
		}
		orb.update(dt, viewer);

		const item = cluster ? orb.item : null;
		if (item) {
			const name = item.name || decodeURIComponent(item.path.split('/').pop());
			this.label.setParts(cluster.items.length > 1
				? [name, { text: `  ${cluster.items.indexOf(item) + 1}/${cluster.items.length}`, style: 'muted' }]
				: [name]);
			this.label.position.copy(orb.position).add(new THREE.Vector3(0, ORB_RADIUS + 0.035, 0));
			this.label.lookAt(viewer);
		}
		this.label.setOpacity(item ? orb.opacity * this.alpha : 0);
	}

	dispose() {
		this.disposeGlobe();
		for (const button of this.buttons) {
			button.geometry.dispose();
			button.material.map.dispose();
			button.material.dispose();
		}
		for (const label of [this.label, this.hint, this.attribution]) {
			label.geometry.dispose();
			label.material.map?.dispose();
			label.material.dispose();
		}
	}
}
