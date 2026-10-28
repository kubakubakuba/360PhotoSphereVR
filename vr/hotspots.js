import { bearing, distanceMeters, itemCoordinates } from './geo.js';

// Directions from the current photo to other photos nearby, for the markers inside the panorama
// (desktop and VR). Yaw 0 is the centre of the panorama, positive to the right; pitch is negative
// below the horizon.

const DEG = Math.PI / 180;
const DEFAULT_PITCH = -3 * DEG; // without a known camera height: just below the horizon
const MIN_DISTANCE = 1; // m; photos taken at the same spot have no direction

function wrapAngle(angle) {
	return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * Nearest photos around `current`, at most `maxCount`, within `maxDistance` metres. Of photos in
 * almost the same direction (closer than `minSeparation` degrees) only the nearest is kept.
 * Empty when the current photo has no position or no heading: markers must not point the wrong way.
 */
export function nearbyPhotos(current, items, { maxDistance = 5000, maxCount = 8, minSeparation = 4 } = {}) {
	const here = itemCoordinates(current);
	const heading = Number(current?.heading);
	if (!here || current.heading == null || !Number.isFinite(heading)) return [];
	const height = Number(current.height);

	const candidates = [];
	for (const item of items) {
		const there = item.path !== current.path && itemCoordinates(item);
		if (!there) continue;
		const distance = distanceMeters(here, there);
		if (distance >= MIN_DISTANCE && distance <= maxDistance) candidates.push({ item, distance, direction: bearing(here, there) });
	}
	candidates.sort((a, b) => a.distance - b.distance);

	const result = [];
	for (const { item, distance, direction } of candidates) {
		if (result.length >= maxCount) break;
		const yaw = wrapAngle((direction - heading) * DEG);
		if (result.some((other) => Math.abs(wrapAngle(other.yaw - yaw)) < minSeparation * DEG)) continue;
		// From a drone, a place on the ground is below the horizon by the camera's height.
		const pitch = Number.isFinite(height) && height > 0 ? -Math.atan2(height, distance) : DEFAULT_PITCH;
		result.push({ item, distance, yaw, pitch });
	}
	return result;
}

export function formatDistance(meters) {
	if (meters < 100) return `${Math.round(meters)} m`;
	if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
	return meters < 10000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters / 1000)} km`;
}

export function photoName(item) {
	return item.name || decodeURIComponent(item.path.split('/').pop());
}

// Can any photo show markers (it needs a position and a heading)?
export function hasHotspots(items) {
	return items.some((item) => itemCoordinates(item) && item.heading != null && Number.isFinite(Number(item.heading)));
}

// Whether the markers are shown: one setting for desktop and VR, remembered per browser.
const VISIBLE_KEY = 'hotspots-visible';
let visible = null;

export function hotspotsVisible() {
	if (visible === null) {
		try {
			visible = localStorage.getItem(VISIBLE_KEY) !== '0';
		} catch {
			visible = true;
		}
	}
	return visible;
}

export function setHotspotsVisible(value) {
	visible = !!value;
	try {
		localStorage.setItem(VISIBLE_KEY, visible ? '1' : '0');
	} catch { /* no storage: this session only */ }
}
