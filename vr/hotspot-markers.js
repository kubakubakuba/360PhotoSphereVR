import * as THREE from 'three';
import { nearbyPhotos, formatDistance, photoName } from './hotspots.js';

// Markers around the user in VR pointing at nearby photos: a dot with the photo's name and distance.
// Drawn over the photo (also over the equirect layer); point at one and select to go there.

const DISTANCE = 12; // m from the head; the photo itself is at infinity
const HEIGHT = 0.55; // m, about 2.6° at that distance
const CANVAS_HEIGHT = 96;
const DOT_RADIUS = 30;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function makeMarker(item, distance, accent) {
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	const name = photoName(item);
	const far = formatDistance(distance);
	const nameFont = `600 38px ${FONT}`;
	const farFont = `500 32px ${FONT}`;
	ctx.font = nameFont;
	const nameWidth = Math.min(ctx.measureText(name).width, 520);
	ctx.font = farFont;
	const farWidth = ctx.measureText(far).width;
	const pillX = DOT_RADIUS * 2 + 22;
	canvas.width = Math.ceil(pillX + 28 + nameWidth + 16 + farWidth + 28);
	canvas.height = CANVAS_HEIGHT;

	// Dot: dark outline, white ring, accent centre (like the map pins).
	const cy = CANVAS_HEIGHT / 2;
	for (const [radius, color] of [[DOT_RADIUS + 6, 'rgba(5, 10, 15, 0.6)'], [DOT_RADIUS, '#ffffff'], [DOT_RADIUS - 8, accent]]) {
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(DOT_RADIUS + 8, cy, radius, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.fillStyle = 'rgba(18, 20, 24, 0.85)';
	ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.roundRect(pillX, 12, canvas.width - pillX - 2, CANVAS_HEIGHT - 24, (CANVAS_HEIGHT - 24) / 2);
	ctx.fill();
	ctx.stroke();
	ctx.textBaseline = 'middle';
	ctx.font = nameFont;
	ctx.fillStyle = '#e8eaed';
	let shown = name;
	while (ctx.measureText(shown).width > nameWidth && shown.length > 1) shown = `${shown.slice(0, -2)}…`;
	ctx.fillText(shown, pillX + 28, cy + 1);
	ctx.font = farFont;
	ctx.fillStyle = '#9aa0a6';
	ctx.fillText(far, pillX + 28 + nameWidth + 16, cy + 1);

	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	const metersPerPixel = HEIGHT / CANVAS_HEIGHT;
	const width = canvas.width * metersPerPixel;
	const geometry = new THREE.PlaneGeometry(width, HEIGHT);
	geometry.translate(width / 2 - (DOT_RADIUS + 8) * metersPerPixel, 0, 0); // the dot sits on the direction
	const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
		map: texture, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
	}));
	mesh.renderOrder = 8;
	return mesh;
}

export class HotspotMarkers extends THREE.Group {
	constructor({ accent = '#43cea2', maxDistance = 5000, onSelect } = {}) {
		super();
		this.accent = accent;
		this.maxDistance = maxDistance;
		this.onSelect = onSelect;
		this.alpha = 0;
		this.markers = [];
	}

	// Markers for the photos around `current`; they show once the photo surrounds the user.
	show(current, items) {
		this.clear();
		const spots = current ? nearbyPhotos(current, items, { maxDistance: this.maxDistance }) : [];
		this.markers = spots.map(({ item, distance, yaw, pitch }) => {
			const mesh = makeMarker(item, distance, this.accent);
			// The photo's centre faces -Z; yaw turns right, pitch up.
			const direction = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
			mesh.userData = { hover: 0, hoverT: 0, direction, path: item.path, onActivate: () => this.onSelect?.(item.path) };
			this.add(mesh);
			return mesh;
		});
	}

	clear() {
		for (const mesh of this.markers) {
			this.remove(mesh);
			mesh.geometry.dispose();
			mesh.material.map.dispose();
			mesh.material.dispose();
		}
		this.markers = [];
	}

	getInteractives() {
		return this.alpha > 0.6 ? this.markers : [];
	}

	update(dt, head, shown) {
		this.alpha += ((shown ? 1 : 0) - this.alpha) * (1 - Math.exp(-dt * (shown ? 4 : 12)));
		this.visible = this.alpha > 0.01 && this.markers.length > 0;
		if (!this.visible) return;
		const hoverEase = 1 - Math.exp(-dt * 18);
		for (const mesh of this.markers) {
			const data = mesh.userData;
			data.hoverT += ((data.hover > 0 ? 1 : 0) - data.hoverT) * hoverEase;
			mesh.position.copy(head).addScaledVector(data.direction, DISTANCE);
			mesh.lookAt(head);
			mesh.scale.setScalar(1 + 0.25 * data.hoverT);
			mesh.material.opacity = this.alpha * (0.85 + 0.15 * data.hoverT);
		}
	}

	dispose() {
		this.clear();
	}
}
