import * as THREE from 'three';
import { LoadingRing } from './loading-ring.js';
import { fetchPreviewBitmap, previewUrl } from './image-source.js';
import { easeOutCubic } from './transitions.js';

// A small spinning photo orb previewing a pin on the globe. Sized in metres for VR;
// the desktop map scales the whole group.

const PREVIEW_SIZE = 1024;
const MAX_CACHED = 8;
const CYCLE_SECONDS = 2.5; // photos taken at the same place take turns
const SPIN_SPEED = 0.5;

export class PreviewOrb extends THREE.Group {
	constructor({ radius = 0.06, accent = '#43cea2', resolveUrl = (path) => path } = {}) {
		super();
		this.radius = radius;
		this.resolveUrl = resolveUrl;
		this.cache = new Map(); // path -> { promise, texture }
		this.items = [];
		this.index = 0;
		this.cycleTime = 0;
		this.appear = 0;
		this.opacity = 0;
		this.targetOpacity = 0;
		this.visible = false;

		const geometry = new THREE.SphereGeometry(1, 48, 24);
		geometry.rotateY(Math.PI / 2); // same orientation as the VR photo orb
		this.material = new THREE.MeshBasicMaterial({ color: 0x1d2128, transparent: true, opacity: 0 });
		this.sphere = new THREE.Mesh(geometry, this.material);
		this.sphere.renderOrder = 7;
		this.add(this.sphere);

		this.ring = new LoadingRing({ radius: radius * 1.15, color: accent });
		this.ring.setProgress(-1);
		this.add(this.ring);
	}

	get item() {
		return this.items[this.index] ?? null;
	}

	// Shows the given photos (several when they were taken at one place).
	show(items) {
		const same = items.length === this.items.length && items.every((item, i) => item.path === this.items[i]?.path);
		this.targetOpacity = 1;
		this.visible = true;
		if (same) return;
		this.items = items;
		this.index = 0;
		this.cycleTime = 0;
		this.appear = 0;
		this.display();
	}

	hide() {
		this.targetOpacity = 0;
	}

	display() {
		const item = this.item;
		this.material.map = null;
		this.material.color.set(0x1d2128);
		this.material.needsUpdate = true;
		if (!item) return;
		this.load(item).then((texture) => {
			if (this.item !== item || this.disposed) return;
			this.material.map = texture;
			this.material.color.set(0xffffff);
			this.material.needsUpdate = true;
		}).catch((error) => {
			if (this.item === item) console.warn(`Could not load preview for ${item.path}:`, error);
		});
		// Warm up the next photo of a group.
		if (this.items.length > 1) this.load(this.items[(this.index + 1) % this.items.length]).catch(() => {});
	}

	load(item) {
		const cached = this.cache.get(item.path);
		if (cached) {
			this.cache.delete(item.path);
			this.cache.set(item.path, cached);
			return cached.promise;
		}
		const url = previewUrl(item) || this.resolveUrl(item.path);
		const entry = { texture: null };
		entry.promise = (async () => {
			const bitmap = await fetchPreviewBitmap(url, PREVIEW_SIZE);
			const texture = new THREE.Texture(bitmap);
			texture.flipY = false; // decodePanorama flips the rows already
			texture.colorSpace = THREE.SRGBColorSpace;
			texture.needsUpdate = true;
			if (this.disposed || this.cache.get(item.path) !== entry) {
				texture.dispose();
				bitmap.close();
				throw new Error('Preview discarded');
			}
			entry.texture = texture;
			return texture;
		})();
		entry.promise.catch(() => this.cache.get(item.path) === entry && this.cache.delete(item.path));
		this.cache.set(item.path, entry);
		this.evict();
		return entry.promise;
	}

	evict() {
		for (const [path, entry] of this.cache) {
			if (this.cache.size <= MAX_CACHED) break;
			if (path === this.item?.path) continue;
			this.cache.delete(path);
			if (entry.texture) {
				entry.texture.dispose();
				entry.texture.image?.close?.();
			}
		}
	}

	update(dt, viewer) {
		this.opacity += (this.targetOpacity - this.opacity) * (1 - Math.exp(-dt * 12));
		if (this.targetOpacity === 0 && this.opacity < 0.01) {
			this.opacity = 0;
			this.visible = false;
			this.items = [];
			return;
		}
		if (!this.visible) return;

		if (this.items.length > 1) {
			this.cycleTime += dt;
			if (this.cycleTime > CYCLE_SECONDS) {
				this.cycleTime = 0;
				this.index = (this.index + 1) % this.items.length;
				this.display();
			}
		}

		const loaded = !!this.material.map;
		if (loaded) this.appear = Math.min(1, this.appear + dt * 4);
		this.sphere.scale.setScalar(this.radius * (0.6 + 0.4 * easeOutCubic(this.appear)));
		this.sphere.rotation.y += dt * SPIN_SPEED;
		this.material.opacity = this.opacity;

		this.ring.opacity = loaded ? 0 : this.opacity;
		this.ring.visible = !loaded;
		this.ring.applyOpacity();
		this.ring.update(dt);
		if (viewer) this.ring.lookAt(viewer);
	}

	dispose() {
		this.disposed = true;
		for (const entry of this.cache.values()) {
			if (entry.texture) {
				entry.texture.dispose();
				entry.texture.image?.close?.();
			}
		}
		this.cache.clear();
		this.material.map = null;
		this.material.dispose();
		this.sphere.geometry.dispose();
		this.ring.dispose();
	}
}
