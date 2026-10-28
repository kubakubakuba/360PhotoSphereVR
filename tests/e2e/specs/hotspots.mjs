// Markers in the desktop panorama pointing at nearby photos.
import assert from 'node:assert/strict';
import { PHOTOS, photoPath } from '../lib/fixtures.mjs';
import { waitForColor, waitForHash } from '../lib/helpers.mjs';

const PRAGUE = PHOTOS[0]; // heading 0 (north), 100 m up
const NEAR = PHOTOS[5]; // ~300 m east of it, heading 0, no height
const NO_HEADING = PHOTOS[4];

const markers = (page) => page.evaluate(() => [...document.querySelectorAll('.hotspot')].map((marker) => {
	const dot = marker.querySelector('.hotspot-dot').getBoundingClientRect();
	return {
		path: marker.dataset.path,
		name: marker.querySelector('strong').textContent,
		distance: marker.querySelector('.hotspot-label span').textContent,
		visible: !marker.hidden,
		x: dot.x + dot.width / 2,
		y: dot.y + dot.height / 2,
	};
}));

async function show(page, photo, view = '') {
	await page.evaluate((hash) => { location.hash = hash; }, `panorama=${encodeURIComponent(photoPath(photo))}${view}`);
	await waitForColor(page, photo.color);
}

export default {
	name: 'hotspots',

	async setup(ctx) {
		const page = await ctx.newPage();
		await page.goto(ctx.server.url);
		await waitForColor(page, PHOTOS.find((photo) => photo.default).color);
		return { page };
	},

	tests: [
		['a nearby photo gets a marker with its name and distance', async (ctx, { page }) => {
			await show(page, PRAGUE);
			const [marker, ...others] = await page.waitFor(async () => {
				const list = await markers(page);
				return list.length > 0 && list;
			}, { message: 'markers' });
			assert.equal(others.length, 0, 'only the photo within 5 km');
			assert.deepEqual([marker.path, marker.name, marker.distance], [photoPath(NEAR), NEAR.name, '300 m']);
		}],

		['the marker points at the photo: east, and down by the camera height', async (ctx, { page }) => {
			// Looking along the expected direction puts the marker in the middle of the view.
			const pitch = -Math.atan2(100, 300) * 180 / Math.PI;
			await page.evaluate((hash) => { location.hash = hash; }, `panorama=${encodeURIComponent(photoPath(PRAGUE))}&yaw=90&pitch=${pitch.toFixed(1)}&zoom=0`);
			const center = await page.evaluate(() => ({ x: innerWidth / 2, y: innerHeight / 2 }));
			await page.waitFor(async () => {
				const [marker] = await markers(page);
				return marker?.visible && Math.hypot(marker.x - center.x, marker.y - center.y) < 12;
			}, { message: 'the marker in the middle of the view' });
		}],

		['clicking a marker opens that photo, which points back', async (ctx, { page }) => {
			await page.click(`.hotspot[data-path="${photoPath(NEAR)}"]`);
			await waitForHash(page, photoPath(NEAR));
			await waitForColor(page, NEAR.color);
			const back = await page.waitFor(async () => (await markers(page))[0], { message: 'marker back' });
			assert.equal(back.path, photoPath(PRAGUE));
		}],

		['the markers button and H hide the markers, remembered after a reload', async (ctx, { page }) => {
			await show(page, PRAGUE, '&yaw=0&pitch=0&zoom=0'); // the marker (east) out of view
			await page.waitFor(async () => (await markers(page)).length > 0, { message: 'markers' });
			const toggle = () => page.evaluate(() => ({
				pressed: document.getElementById('toggle-hotspots-btn').getAttribute('aria-pressed'),
				shown: !document.querySelector('.hotspots').hidden,
			}));
			assert.deepEqual(await toggle(), { pressed: 'true', shown: true });
			await page.click('#toggle-hotspots-btn');
			assert.deepEqual(await toggle(), { pressed: 'false', shown: false });
			await page.reload();
			await waitForColor(page, PRAGUE.color);
			assert.deepEqual(await toggle(), { pressed: 'false', shown: false });
			await page.press('h', 'KeyH', 72);
			assert.deepEqual(await toggle(), { pressed: 'true', shown: true });
		}],

		['photos without a heading get no markers', async (ctx, { page }) => {
			await show(page, NO_HEADING);
			await page.waitFor(async () => (await markers(page)).length === 0, { message: 'no markers' });
		}],
	],
};
