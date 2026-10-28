import { nearbyPhotos, formatDistance, photoName } from './vr/hotspots.js';

// Markers inside the desktop panorama pointing at nearby photos (Street View style).
// HTML elements over Photo Sphere Viewer's canvas, moved on every render.

export class PanoramaHotspots {
	/**
	 * @param viewer    Photo Sphere Viewer instance
	 * @param onSelect  (path) => void
	 */
	constructor({ viewer, onSelect, maxDistance }) {
		this.viewer = viewer;
		this.onSelect = onSelect;
		this.maxDistance = maxDistance;
		this.spots = [];
		this.root = document.createElement('div');
		this.root.className = 'hotspots';
		viewer.container.append(this.root);
		this.onRender = () => this.position();
		viewer.addEventListener('render', this.onRender);
	}

	show(current, items) {
		const spots = current ? nearbyPhotos(current, items, { maxDistance: this.maxDistance }) : [];
		this.spots = spots.map((spot) => ({ ...spot, element: this.createMarker(spot) }));
		this.root.replaceChildren(...this.spots.map((spot) => spot.element));
		this.position();
	}

	setVisible(visible) {
		this.root.hidden = !visible;
		this.position();
	}

	createMarker({ item, distance }) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'hotspot';
		button.dataset.path = item.path;
		const dot = document.createElement('span');
		dot.className = 'hotspot-dot';
		const label = document.createElement('span');
		label.className = 'hotspot-label';
		const name = document.createElement('strong');
		name.textContent = photoName(item);
		const far = document.createElement('span');
		far.textContent = formatDistance(distance);
		label.append(name, far);
		button.append(dot, label);
		button.setAttribute('aria-label', `${name.textContent}, ${far.textContent} away`);
		// Keep presses away from the viewer, so they don't start a drag.
		for (const type of ['pointerdown', 'mousedown', 'touchstart']) button.addEventListener(type, (event) => event.stopPropagation());
		button.addEventListener('click', () => this.onSelect?.(item.path));
		return button;
	}

	position() {
		if (this.root.hidden) return;
		const helper = this.viewer.dataHelper;
		for (const { yaw, pitch, element } of this.spots) {
			const point = { yaw, pitch };
			const visible = helper.isPointVisible(point);
			element.hidden = !visible;
			if (!visible) continue;
			const { x, y } = helper.sphericalCoordsToViewerCoords(point);
			element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
		}
	}

	destroy() {
		this.viewer.removeEventListener('render', this.onRender);
		this.root.remove();
		this.spots = [];
	}
}
