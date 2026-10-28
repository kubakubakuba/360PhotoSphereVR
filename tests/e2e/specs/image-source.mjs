// Unit-style checks of vr/image-source.js, run inside the page (it needs browser image APIs).
import assert from 'node:assert/strict';
import { UPLOADS } from '../lib/fixtures.mjs';

export default {
	name: 'image decoding',

	async setup(ctx) {
		const page = await ctx.newPage();
		await page.goto(ctx.server.url); // provides the import map for 'three'
		return { page };
	},

	tests: [
		['reads sizes from JPEG, PNG and WebP headers', async (ctx, { page }) => {
			const result = await page.evaluate(async () => {
				const { readImageSize } = await import('/vr/image-size.js');
				const check = async (url) => {
					const blob = await (await fetch(url)).blob();
					const image = new Image();
					image.src = url;
					await image.decode();
					return { header: await readImageSize(blob), actual: { width: image.naturalWidth, height: image.naturalHeight } };
				};
				return {
					jpeg: await check('/imgs/p1.jpg'),
					webp: await check('/thumb/p1.thumb.webp'),
					png: await check('/placeholder_thumbnail.png'),
				};
			});
			for (const [format, { header, actual }] of Object.entries(result)) assert.deepEqual(header, actual, format);
		}],

		['finds the JPEG size behind large metadata segments', async (ctx, { page }) => {
			const size = await page.evaluate(async () => {
				const { readImageSize } = await import('/vr/image-size.js');
				const jpeg = new Uint8Array(await (await fetch('/imgs/p1.jpg')).arrayBuffer());
				// Insert three ~64 kB APP1 segments (like EXIF/XMP from cameras) after the SOI marker.
				const segment = new Uint8Array(0xfff2);
				segment.set([0xff, 0xe1, 0xff, 0xf0]);
				const blob = new Blob([jpeg.subarray(0, 2), segment, segment, segment, jpeg.subarray(2)], { type: 'image/jpeg' });
				return { padded: await readImageSize(blob), original: await readImageSize(new Blob([jpeg])) };
			});
			assert.ok(size.original, 'original size');
			assert.deepEqual(size.padded, size.original);
		}],

		['returns null for unknown data', async (ctx, { page }) => {
			assert.equal(await page.evaluate(async () => {
				const { readImageSize } = await import('/vr/image-size.js');
				return readImageSize(new Blob(['definitely not an image']));
			}), null);
		}],

		['unseals .pano files while downloading, other files pass through', async (ctx, { page }) => {
			const result = await page.evaluate(async () => {
				const { downloadBlob } = await import('/vr/image-source.js');
				const bytes = async (blob) => Array.from(new Uint8Array(await blob.arrayBuffer()));
				const original = await bytes(await (await fetch('/imgs/p7.jpg')).blob());
				const sealed = await bytes(await (await fetch('/imgs/p7.pano')).blob());
				const same = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
				return {
					sealedDiffers: !same(sealed.slice(8), original),
					unsealed: same(await bytes(await downloadBlob('/imgs/p7.pano')), original),
					withProgress: same(await bytes(await downloadBlob('/imgs/p7.pano', () => {})), original),
					plain: same(await bytes(await downloadBlob('/imgs/p7.jpg')), original),
				};
			});
			assert.deepEqual(result, { sealedDiffers: true, unsealed: true, withProgress: true, plain: true });
		}],

		['decodes panoramas to the capped size, also without a usable header', async (ctx, { page }) => {
			const sizes = await page.evaluate(async (oddFile) => {
				const { decodePanorama } = await import('/vr/image-source.js');
				const decode = async (url, maxSize) => {
					const bitmap = await decodePanorama(await (await fetch(url)).blob(), { maxSize });
					const size = [bitmap.width, bitmap.height];
					bitmap.close();
					return size;
				};
				const image = new Image();
				image.src = '/imgs/p1.jpg';
				await image.decode();
				return {
					capped: await decode('/imgs/p1.jpg', 1024), // header fast path
					uncapped: await decode('/imgs/p1.jpg', 16384),
					original: [image.naturalWidth, image.naturalHeight],
					notTwoToOne: await decode(`/uploads/${encodeURIComponent(oddFile)}`, 1500), // full decode fallback
				};
			}, UPLOADS.odd.file);
			assert.deepEqual(sizes.capped, [1024, 512]);
			assert.deepEqual(sizes.uncapped, sizes.original);
			assert.deepEqual(sizes.notTwoToOne, [1500, 1000]);
		}],
	],
};
