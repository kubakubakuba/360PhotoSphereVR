import * as THREE from 'three';

// Geographic helpers shared by the desktop globe and the VR globe.
// Globe-local axes match an equirect texture on THREE.SphereGeometry:
// lon 0 lies on +X, lon 90° E on -Z, the north pole on +Y.

const DEG = Math.PI / 180;
export const MAX_MERCATOR_LAT = 85.05112878;
export const TILE_SIZE = 256;

export function latLonToVector3(lat, lon, radius = 1, target = new THREE.Vector3()) {
	const cosLat = Math.cos(lat * DEG);
	return target.set(Math.cos(lon * DEG) * cosLat * radius, Math.sin(lat * DEG) * radius, -Math.sin(lon * DEG) * cosLat * radius);
}

export function vector3ToLatLon(vector) {
	const length = vector.length() || 1;
	return {
		lat: Math.asin(THREE.MathUtils.clamp(vector.y / length, -1, 1)) / DEG,
		lon: Math.atan2(-vector.z, vector.x) / DEG,
	};
}

export function wrapLon(lon) {
	return ((((lon + 180) % 360) + 360) % 360) - 180;
}

// Great-circle distance in radians.
export function angularDistance(a, b) {
	const dLat = (b.lat - a.lat) * DEG;
	const dLon = (b.lon - a.lon) * DEG;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
	return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Coordinates of a gallery / library item, or null when it has none (or they are invalid).
export function itemCoordinates(item) {
	const lat = Number(item?.lat);
	const lon = Number(item?.lon);
	if (item?.lat == null || item?.lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
	return { lat, lon };
}

// --- Web Mercator tiles (slippy map numbering) ---------------------------

export function lonToTileX(lon, zoom) {
	return ((lon + 180) / 360) * 2 ** zoom;
}

export function latToTileY(lat, zoom) {
	const clamped = THREE.MathUtils.clamp(lat, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT) * DEG;
	return ((1 - Math.log(Math.tan(clamped) + 1 / Math.cos(clamped)) / Math.PI) / 2) * 2 ** zoom;
}

export function tileXToLon(x, zoom) {
	return (x / 2 ** zoom) * 360 - 180;
}

export function tileYToLat(y, zoom) {
	return Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** zoom))) / DEG;
}
