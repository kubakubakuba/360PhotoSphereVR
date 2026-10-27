import * as THREE from 'three';
import { latLonToVector3, lonToTileX, latToTileY, tileXToLon, tileYToLat, TILE_SIZE } from './geo.js';

// Online map tiles (Web Mercator, {z}/{x}/{y}) draped over the globe. Around the focus point the
// level matching the zoom is loaded, plus two coarser levels that cover the surroundings. Loaded tiles
// stay on the globe until the cache needs room, finer ones drawn over coarser ones; the bundled Earth
// texture underneath only shows where no tile has loaded (yet, or at all when offline).

const BASE_LEVEL = 4; // level loaded however far out the view is (the bundled texture is about as sharp)
const COARSEST_LEVEL = 2;
const FINER_SHOWN = 2; // cached tiles this many levels finer than the view still show; finer ones wait
const RINGS = [
	{ step: 0, range: 3 }, // the zoom's level: 7 × 7 tiles around the focus
	{ step: 2, range: 2 }, // 4× coarser: 5 × 5, about 20 × 20 tiles of the zoom's level
	{ step: 4, range: 2 }, // 16× coarser
];
const SEGMENTS = 16;
const MAX_LOADING = 6;

// Mercator tiles get smaller on the ground towards the poles: their size relative to the equator.
function groundScale(lat) {
	return Math.max(Math.cos(THREE.MathUtils.degToRad(lat)), 0.05);
}

function createTileGeometry(z, x, y) {
	const positions = [];
	const uvs = [];
	const indices = [];
	const point = new THREE.Vector3();
	for (let row = 0; row <= SEGMENTS; row++) {
		// Vertex rows follow the Mercator spacing, so the texture maps linearly.
		const lat = tileYToLat(y + row / SEGMENTS, z);
		for (let col = 0; col <= SEGMENTS; col++) {
			latLonToVector3(lat, tileXToLon(x + col / SEGMENTS, z), 1, point);
			positions.push(point.x, point.y, point.z);
			uvs.push(col / SEGMENTS, 1 - row / SEGMENTS);
		}
	}
	for (let row = 0; row < SEGMENTS; row++) {
		for (let col = 0; col < SEGMENTS; col++) {
			const a = row * (SEGMENTS + 1) + col;
			const b = a + SEGMENTS + 1;
			indices.push(a, b, a + 1, b, b + 1, a + 1);
		}
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
	geometry.setIndex(indices);
	geometry.computeBoundingSphere();
	return geometry;
}

export class TileLayer extends THREE.Group {
	/**
	 * @param url             template with {z}, {x} and {y}; empty disables tiles
	 * @param maxCached       tiles kept (each ~350 kB of GPU memory); the least recently needed go first
	 * @param createMaterial  returns a material for one tile (the globe adds its fade to it)
	 */
	constructor({ url = '', maxZoom = 17, maxCached = 256, createMaterial }) {
		super();
		this.url = url;
		this.maxZoom = Math.max(COARSEST_LEVEL, Math.min(Number(maxZoom) || 17, 22));
		this.maxCached = maxCached;
		this.createMaterial = createMaterial;
		this.offline = false; // set after a network / CORS failure; no more requests for this globe
		this.tiles = new Map(); // "z/x/y" -> tile
		this.queue = [];
		this.loading = 0;
		this.frame = 0;
		this.visibleCount = 0;
	}

	get enabled() {
		return !!this.url;
	}

	get available() {
		return this.enabled && !this.offline;
	}

	// Tile level matching the globe's on-screen size at the focus point.
	static levelFor(altitude, pixelsPerRadian, lat = 0) {
		return Math.round(Math.log2((2 * Math.PI * pixelsPerRadian * groundScale(lat)) / (TILE_SIZE * altitude)));
	}

	// Lowest altitude at which the most detailed tile level is still sharp.
	minAltitude(pixelsPerRadian, lat = 0) {
		return (2 * Math.PI * pixelsPerRadian * groundScale(lat)) / (TILE_SIZE * 2 ** this.maxZoom);
	}

	update(view, pixelsPerRadian) {
		this.frame++;
		const wanted = new Set();
		const level = THREE.MathUtils.clamp(TileLayer.levelFor(view.altitude, pixelsPerRadian, view.lat), BASE_LEVEL, this.maxZoom);
		if (this.available && navigator.onLine !== false) {
			RINGS.forEach(({ step, range }, ring) => {
				const z = level - step;
				if (z >= COARSEST_LEVEL) this.request(z, range, ring, view, wanted);
			});
			// Tiles that scrolled out of view before they started loading are dropped.
			this.queue = this.queue.filter((tile) => {
				if (wanted.has(tile.key)) return true;
				this.tiles.delete(tile.key);
				return false;
			});
			this.queue.sort((a, b) => a.priority - b.priority);
			this.pump();
		}

		// Everything loaded stays visible (also when the network goes away), except tiles so much finer
		// than the view that they would add no detail, only draw calls and patches of other imagery.
		this.visibleCount = 0;
		for (const tile of this.tiles.values()) {
			if (!tile.mesh) continue;
			tile.mesh.visible = tile.state === 'ready' && tile.z <= level + FINER_SHOWN;
			if (tile.mesh.visible) this.visibleCount++;
		}
		this.evict(wanted);
	}

	// Wants the (2 range + 1)² tiles of level z around the focus.
	request(z, range, ring, view, wanted) {
		const count = 2 ** z;
		const centerX = Math.floor(lonToTileX(view.lon, z));
		const centerY = Math.floor(latToTileY(view.lat, z));
		for (let dy = -range; dy <= range; dy++) {
			const y = centerY + dy;
			if (y < 0 || y >= count) continue;
			for (let dx = -range; dx <= range; dx++) {
				const x = (((centerX + dx) % count) + count) % count;
				const key = `${z}/${x}/${y}`;
				if (wanted.has(key)) continue; // small levels wrap around onto themselves
				let tile = this.tiles.get(key);
				if (!tile) {
					tile = { key, z, x, y, state: 'queued', mesh: null, texture: null };
					this.tiles.set(key, tile);
					this.queue.push(tile);
				}
				// The focus first, then coarse cover, then the rest of the detail.
				tile.priority = Math.max(Math.abs(dx), Math.abs(dy)) + ring;
				tile.used = this.frame;
				wanted.add(key);
			}
		}
	}

	// Least recently needed tiles go first; among equally old ones the finest (covering the least).
	evict(wanted) {
		if (this.tiles.size <= this.maxCached) return;
		const candidates = [...this.tiles.values()]
			.filter((tile) => !wanted.has(tile.key) && tile.state !== 'loading')
			.sort((a, b) => a.used - b.used || b.z - a.z);
		for (const tile of candidates.slice(0, this.tiles.size - this.maxCached)) this.disposeTile(tile);
	}

	pump() {
		while (this.loading < MAX_LOADING && this.queue.length > 0 && this.available) {
			this.load(this.queue.shift());
		}
	}

	tileUrl({ z, x, y }) {
		return this.url.replaceAll('{z}', z).replaceAll('{x}', x).replaceAll('{y}', y);
	}

	async load(tile) {
		tile.state = 'loading';
		this.loading++;
		try {
			const response = await fetch(this.tileUrl(tile), { mode: 'cors', credentials: 'omit' });
			if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { missing: true });
			const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: 'flipY' });
			if (tile.disposed) {
				bitmap.close();
				return;
			}
			const texture = new THREE.Texture(bitmap);
			texture.flipY = false; // flipped while decoding
			texture.colorSpace = THREE.SRGBColorSpace;
			texture.anisotropy = 4;
			texture.needsUpdate = true;
			const material = this.createMaterial();
			material.map = texture;
			tile.texture = texture;
			tile.mesh = new THREE.Mesh(createTileGeometry(tile.z, tile.x, tile.y), material);
			tile.mesh.renderOrder = 1 + tile.z / 100; // finer levels draw over coarser ones
			tile.mesh.visible = false;
			this.add(tile.mesh);
			tile.state = 'ready';
		} catch (error) {
			tile.state = 'failed';
			// A missing tile is just a gap; a failed request means no network (or no CORS).
			if (!error.missing && !this.offline && !tile.disposed) {
				this.offline = true;
				console.warn(`Map tiles unavailable (${error.message}), using the built-in Earth texture`);
			}
		} finally {
			this.loading--;
			this.pump();
		}
	}

	disposeTile(tile) {
		tile.disposed = true;
		this.tiles.delete(tile.key);
		if (tile.mesh) {
			this.remove(tile.mesh);
			tile.mesh.geometry.dispose();
			tile.mesh.material.dispose();
		}
		if (tile.texture) {
			tile.texture.dispose();
			tile.texture.image?.close?.();
		}
	}

	dispose() {
		this.queue = [];
		for (const tile of [...this.tiles.values()]) this.disposeTile(tile);
	}
}
