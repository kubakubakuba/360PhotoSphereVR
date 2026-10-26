// Generates test panoramas in the browser (canvas) and caches them on disk.
// Each photo is a solid, distinct colour so screenshots can tell which one is shown.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = 1;

export const PHOTOS = [
	{ file: 'p1.jpg', name: 'Fixture Cyan', color: [40, 170, 200] },
	{ file: 'p2.jpg', name: 'Fixture Orange', color: [225, 125, 40], default: true },
	{ file: 'p3.jpg', name: 'Fixture Green', color: [60, 175, 70] },
	{ file: 'p4.jpg', name: 'Fixture Purple', color: [140, 80, 205] },
	{ file: 'p5.jpg', name: 'Fixture Red', color: [215, 55, 75] },
	{ file: 'p6.jpg', name: 'Fixture Yellow', color: [205, 185, 45] },
	{ file: 'p7.jpg', name: 'Fixture Blue', color: [50, 90, 215] },
];

export const UPLOADS = {
	trip: { file: 'Upload Trip.jpg', name: 'Upload Trip', color: [230, 110, 180], width: 4096, height: 2048 },
	odd: { file: 'odd-ratio.webp', name: 'odd-ratio', color: [95, 140, 60], width: 3000, height: 2000 },
	broken: { file: 'broken.jpg' },
};

// Runs in the page: draws a panorama and returns it base64 encoded.
async function render({ width, height, color, label, type, quality }) {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = `rgb(${color.join(',')})`;
	ctx.fillRect(0, 0, width, height);
	if (label) {
		const step = Math.round(width / 16);
		ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
		ctx.lineWidth = Math.max(1, width / 2048);
		for (let x = 0; x <= width; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
		for (let y = 0; y <= height; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
		// Labels above the horizon, so the view centre stays a clean sample area.
		ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
		ctx.font = `bold ${Math.round(height / 16)}px sans-serif`;
		ctx.textAlign = 'center';
		['FRONT', 'RIGHT', 'BACK', 'LEFT'].forEach((side, i) => {
			ctx.fillText(`${label} ${side}`, ((0.5 + i * 0.25) % 1) * width, height * 0.3);
		});
	}
	const blob = await canvas.convertToBlob({ type, quality });
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/**
 * Ensures fixtures exist under `dir` and returns their paths.
 * @param page  a launched browser page used for rendering
 */
export async function ensureFixtures(page, dir, { panoramaWidth = 4096 } = {}) {
	const manifestPath = join(dir, 'manifest.json');
	const paths = {
		dir,
		imgs: join(dir, 'imgs'),
		thumbs: join(dir, 'thumb'),
		gallery: join(dir, 'gallery.json'),
		uploads: join(dir, 'uploads'),
	};
	const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
	if (manifest?.version === VERSION && manifest.panoramaWidth === panoramaWidth) return paths;

	rmSync(dir, { recursive: true, force: true });
	for (const sub of [paths.imgs, paths.thumbs, paths.uploads]) mkdirSync(sub, { recursive: true });
	const write = async (file, options) => writeFileSync(file, Buffer.from(await page.evaluate(render, options), 'base64'));

	const gallery = [];
	for (const [index, photo] of PHOTOS.entries()) {
		const thumb = photo.file.replace('.jpg', '.thumb.webp');
		await write(join(paths.imgs, photo.file), { width: panoramaWidth, height: panoramaWidth / 2, color: photo.color, label: index + 1, type: 'image/jpeg', quality: 0.9 });
		await write(join(paths.thumbs, thumb), { width: 400, height: 200, color: photo.color, label: index + 1, type: 'image/webp', quality: 0.8 });
		gallery.push({
			id: photo.file.replace('.jpg', ''),
			name: photo.name,
			path: `./imgs/${photo.file}`,
			thumbnail: `./thumb/${thumb}`,
			description: 'Test fixture',
			...(photo.default ? { default: true } : {}),
		});
	}
	writeFileSync(paths.gallery, JSON.stringify(gallery, null, 2));

	const { trip, odd, broken } = UPLOADS;
	await write(join(paths.uploads, trip.file), { width: trip.width, height: trip.height, color: trip.color, label: 'UP', type: 'image/jpeg', quality: 0.9 });
	await write(join(paths.uploads, odd.file), { width: odd.width, height: odd.height, color: odd.color, label: 'ODD', type: 'image/webp', quality: 0.85 });
	writeFileSync(join(paths.uploads, broken.file), 'this is not an image');

	writeFileSync(manifestPath, JSON.stringify({ version: VERSION, panoramaWidth }));
	return paths;
}

export const photoPath = (photo) => `./imgs/${photo.file}`;
