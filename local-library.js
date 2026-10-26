// Panoramas the user adds from their own device. Stored in IndexedDB so they
// survive reloads (and never leave the browser); falls back to memory when
// IndexedDB is unavailable, e.g. in some private browsing modes.

import { readImageSize, isPanoramaSize } from './vr/image-size.js';

const DB_NAME = 'panorama-library';
const DB_VERSION = 1;
const STORE = 'photos';
const PREFIX = 'local:';
const THUMB_WIDTH = 512;
const THUMB_HEIGHT = 256;

function request(req) {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function openDatabase() {
	return new Promise((resolve, reject) => {
		if (!window.indexedDB) {
			reject(new Error('IndexedDB not available'));
			return;
		}
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error('IndexedDB blocked'));
	});
}

function newId() {
	return window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function formatSize(bytes) {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

// Decodes the image (validating it) and renders a 2:1 cover-cropped thumbnail.
// For panoramas the size comes from the file header, so the image is decoded straight at
// thumbnail size instead of at full resolution (~290 MB for a 72 MP photo).
async function createThumbnail(blob) {
	const header = await readImageSize(blob).catch(() => null);
	let bitmap;
	let size;
	if (header && isPanoramaSize(header)) {
		const scale = Math.max(THUMB_WIDTH / header.width, THUMB_HEIGHT / header.height);
		bitmap = await createImageBitmap(blob, {
			resizeWidth: Math.max(THUMB_WIDTH, Math.round(header.width * scale)),
			resizeHeight: Math.max(THUMB_HEIGHT, Math.round(header.height * scale)),
			resizeQuality: 'high',
		});
		size = header;
	} else {
		bitmap = await createImageBitmap(blob);
		size = { width: bitmap.width, height: bitmap.height };
	}

	try {
		const scale = Math.max(THUMB_WIDTH / bitmap.width, THUMB_HEIGHT / bitmap.height);
		const sw = THUMB_WIDTH / scale;
		const sh = THUMB_HEIGHT / scale;
		const canvas = typeof OffscreenCanvas !== 'undefined'
			? new OffscreenCanvas(THUMB_WIDTH, THUMB_HEIGHT)
			: Object.assign(document.createElement('canvas'), { width: THUMB_WIDTH, height: THUMB_HEIGHT });
		const ctx = canvas.getContext('2d');
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
		const thumb = canvas.convertToBlob
			? await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
			: await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
		return { thumb, ...size };
	} finally {
		bitmap.close();
	}
}

export class LocalLibrary {
	constructor() {
		this.db = null;
		this.persistent = false;
		this.records = new Map(); // id -> record
		this.urls = new Map(); // id -> { image, thumb } object URLs
	}

	static isLocal(path) {
		return typeof path === 'string' && path.startsWith(PREFIX);
	}

	async open() {
		try {
			this.db = await openDatabase();
			this.persistent = true;
			const records = await request(this.db.transaction(STORE).objectStore(STORE).getAll());
			records.forEach((record) => this.remember(record));
		} catch (error) {
			console.warn('Local library: falling back to session-only storage:', error);
			this.db = null;
			this.persistent = false;
		}
	}

	remember(record) {
		this.records.set(record.id, record);
		this.urls.set(record.id, {
			image: URL.createObjectURL(record.blob),
			thumb: record.thumb ? URL.createObjectURL(record.thumb) : '',
		});
	}

	// Gallery entries, newest first.
	get items() {
		return [...this.records.values()]
			.sort((a, b) => b.added - a.added)
			.map((record) => {
				const ratio = record.width / record.height;
				const details = [`${record.width}×${record.height}`, formatSize(record.size)];
				if (Math.abs(ratio - 2) > 0.05) details.push('not 2:1, may look distorted');
				return {
					id: record.id,
					name: record.name,
					path: PREFIX + record.id,
					thumbnail: this.urls.get(record.id)?.thumb || '',
					description: details.join(' · '),
					local: true,
				};
			});
	}

	// Object URL for a local: path, or null if it isn't one (or no longer exists).
	resolve(path) {
		if (!LocalLibrary.isLocal(path)) return null;
		return this.urls.get(path.slice(PREFIX.length))?.image ?? null;
	}

	has(path) {
		return this.resolve(path) !== null;
	}

	async add(files) {
		const added = [];
		const existing = [];
		const failed = [];
		for (const file of files) {
			if (file.type && !file.type.startsWith('image/')) {
				failed.push({ name: file.name, reason: 'not an image' });
				continue;
			}
			const duplicate = [...this.records.values()].find((r) => r.name === stripExtension(file.name) && r.size === file.size);
			if (duplicate) {
				existing.push(PREFIX + duplicate.id);
				continue;
			}
			try {
				const { thumb, width, height } = await createThumbnail(file);
				const record = {
					id: newId(),
					name: stripExtension(file.name),
					type: file.type,
					size: file.size,
					width,
					height,
					added: Date.now(),
					blob: file,
					thumb,
				};
				if (this.db) {
					const tx = this.db.transaction(STORE, 'readwrite');
					tx.objectStore(STORE).put(record);
					await new Promise((resolve, reject) => {
						tx.oncomplete = resolve;
						tx.onerror = () => reject(tx.error);
						tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
					});
				}
				this.remember(record);
				added.push(PREFIX + record.id);
			} catch (error) {
				console.warn(`Local library: could not add ${file.name}:`, error);
				failed.push({ name: file.name, reason: error.name === 'QuotaExceededError' ? 'storage full' : 'could not be read' });
			}
		}
		if (added.length && this.persistent) navigator.storage?.persist?.().catch(() => {});
		return { added, existing, failed };
	}

	async remove(path) {
		if (!LocalLibrary.isLocal(path)) return;
		const id = path.slice(PREFIX.length);
		if (this.db) await request(this.db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
		const urls = this.urls.get(id);
		if (urls) {
			URL.revokeObjectURL(urls.image);
			if (urls.thumb) URL.revokeObjectURL(urls.thumb);
		}
		this.urls.delete(id);
		this.records.delete(id);
	}
}

function stripExtension(name) {
	return name.replace(/\.[^.]+$/, '') || name;
}
