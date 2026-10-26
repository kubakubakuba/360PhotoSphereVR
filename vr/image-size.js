// Reads image dimensions from file headers without decoding. No dependencies, so it can be
// used by the desktop page (local library) as well as the VR viewer.

const HEADER_BYTES = 1024 * 1024;
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * Reads the pixel size from a JPEG, PNG or WebP header without decoding the image.
 * Returns null for other formats or when the header isn't within the first megabyte.
 */
export async function readImageSize(blob) {
	const bytes = new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer());
	const u16be = (i) => (bytes[i] << 8) | bytes[i + 1];
	const ascii = (i, length) => String.fromCharCode(...bytes.subarray(i, i + length));

	// JPEG: walk the marker segments up to the start-of-frame
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let i = 2;
		while (i + 9 < bytes.length) {
			if (bytes[i] !== 0xff) return null;
			const marker = bytes[i + 1];
			if (marker === 0xff) { i++; continue; }
			if (JPEG_SOF_MARKERS.has(marker)) return { width: u16be(i + 7), height: u16be(i + 5) };
			if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
			i += 2 + u16be(i + 2);
		}
		return null;
	}

	// PNG: IHDR is always the first chunk
	if (bytes.length >= 24 && ascii(1, 3) === 'PNG') {
		const view = new DataView(bytes.buffer);
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}

	// WebP: lossy, lossless or extended container
	if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
		const chunk = ascii(12, 4);
		if (chunk === 'VP8 ') return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
		if (chunk === 'VP8L') {
			return {
				width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
				height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6)),
			};
		}
		if (chunk === 'VP8X') {
			return {
				width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
				height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
			};
		}
	}
	return null;
}

// 360° equirectangular panoramas are 2:1. Header sizes are only trusted for those, since
// EXIF-rotated photos report their pre-rotation size in the header.
export function isPanoramaSize({ width, height }) {
	return Math.abs(width / height - 2) < 0.02;
}
