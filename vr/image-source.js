import * as THREE from 'three';
import { readImageSize, isPanoramaSize } from './image-size.js';

export { readImageSize };

// Fetches and decodes panoramas without blocking the render loop:
// bytes are streamed (for progress), decoding happens off the main thread
// via createImageBitmap, and GPU upload is triggered explicitly.

const MAX_CACHED_BLOBS = 3;
const blobCache = new Map(); // url -> Promise<Blob>

function rememberBlob(url, promise) {
	blobCache.delete(url);
	blobCache.set(url, promise);
	while (blobCache.size > MAX_CACHED_BLOBS) {
		blobCache.delete(blobCache.keys().next().value);
	}
	promise.catch(() => blobCache.delete(url));
}

async function downloadBlob(url, onProgress) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}`);

	const total = Number(response.headers.get('content-length')) || 0;
	if (!response.body || !total || !onProgress) return response.blob();

	const reader = response.body.getReader();
	const chunks = [];
	let loaded = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		loaded += value.length;
		onProgress(Math.min(loaded / total, 1));
	}
	return new Blob(chunks, { type: response.headers.get('content-type') || '' });
}

export async function fetchBlob(url, onProgress) {
	const cached = blobCache.get(url);
	if (cached) {
		const blob = await cached;
		onProgress?.(1);
		return blob;
	}
	const promise = downloadBlob(url, onProgress);
	rememberBlob(url, promise);
	return promise;
}

export function prefetch(url) {
	if (!url || blobCache.has(url)) return;
	fetchBlob(url).catch((error) => console.warn('Prefetch failed:', url, error));
}

function fitSize({ width, height }, maxSize) {
	const scale = Math.min(1, maxSize / width, maxSize / height);
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scaled: scale < 1 };
}

function bitmapOptions(target) {
	return {
		imageOrientation: 'flipY',
		premultiplyAlpha: 'none',
		...(target.scaled ? { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'high' } : {}),
	};
}

/**
 * Decodes a panorama blob into a vertically flipped ImageBitmap (GL row order),
 * downscaled to fit maxSize.
 */
export async function decodePanorama(blob, { maxSize = 8192 } = {}) {
	// Fast path: with the size known up front, decode straight to the target size instead of
	// keeping a full-resolution copy around (~290 MB for a 72 MP photo). Only trusted for 2:1
	// images, since EXIF-rotated photos report their pre-rotation size in the header.
	const size = await readImageSize(blob).catch(() => null);
	if (size && isPanoramaSize(size)) {
		const target = fitSize(size, maxSize);
		const bitmap = await createImageBitmap(blob, bitmapOptions(target));
		if (bitmap.width === target.width && bitmap.height === target.height) {
			if (target.scaled) console.log(`Panorama downscaled from ${size.width}x${size.height} to ${target.width}x${target.height}`);
			return bitmap;
		}
		bitmap.close();
	}

	const raw = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
	const target = fitSize(raw, maxSize);
	const bitmap = await createImageBitmap(raw, bitmapOptions(target));
	if (target.scaled) console.log(`Panorama downscaled from ${raw.width}x${raw.height} to ${target.width}x${target.height}`);
	raw.close();
	return bitmap;
}

// Rows uploaded per frame: large single uploads stall the frame loop for
// seconds on standalone headsets, which shows up as missing imagery when
// the compositor has to reproject an old frame.
const STRIP_BYTES = 8 * 1024 * 1024;

/**
 * Allocates GPU storage (with mip levels) for a panorama without uploading any pixels.
 * Holds raw sRGB-encoded bytes (NoColorSpace) so it can be blitted 1:1 into an
 * XR layer; materials sampling it must decode sRGB themselves.
 */
export function createPanoramaTexture(width, height, renderer) {
	const texture = new THREE.DataTexture(null, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
	texture.colorSpace = THREE.NoColorSpace;
	texture.generateMipmaps = true;
	texture.minFilter = THREE.LinearMipmapLinearFilter;
	texture.magFilter = THREE.LinearFilter;
	texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
	texture.source.dataReady = false; // allocate only, pixels are streamed in below
	texture.needsUpdate = true;
	renderer.initTexture(texture);
	return texture;
}

function resetUnpackState(gl) {
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
	gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
	gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
	gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
}

/**
 * Streams a bitmap into a texture created by createPanoramaTexture, one strip per frame,
 * then generates mipmaps.
 */
export async function streamToTexture(bitmap, texture, renderer, { nextFrame, isCancelled = () => false, onProgress } = {}) {
	const gl = renderer.getContext();
	const glTexture = renderer.properties.get(texture).__webglTexture;
	const { width, height } = bitmap;
	const rows = Math.max(16, Math.floor(STRIP_BYTES / (width * 4)));

	const withTexture = (draw) => {
		gl.bindTexture(gl.TEXTURE_2D, glTexture);
		draw();
		gl.bindTexture(gl.TEXTURE_2D, null);
		renderer.resetState();
	};

	for (let y = 0; y < height; y += rows) {
		const stripHeight = Math.min(rows, height - y);
		const strip = await createImageBitmap(bitmap, 0, y, width, stripHeight, { premultiplyAlpha: 'none' });
		await nextFrame();
		if (isCancelled()) {
			strip.close();
			throw new Error('Upload cancelled');
		}
		withTexture(() => {
			resetUnpackState(gl);
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, width, stripHeight, gl.RGBA, gl.UNSIGNED_BYTE, strip);
		});
		strip.close();
		onProgress?.((y + stripHeight) / height);
	}

	await nextFrame();
	if (isCancelled()) throw new Error('Upload cancelled');
	withTexture(() => gl.generateMipmap(gl.TEXTURE_2D));
}
