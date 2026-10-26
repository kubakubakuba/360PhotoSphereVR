import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PHOTOS, UPLOADS, photoPath } from '../lib/fixtures.mjs';
import { currentHash, waitForColor, waitForHash, waitForToast } from '../lib/helpers.mjs';

const defaultPhoto = PHOTOS.find((photo) => photo.default);

const localCards = (page) => page.evaluate(() => [...document.querySelectorAll('#local-grid .gallery-card')].map((card) => ({
	name: card.querySelector('h3').textContent,
	description: card.querySelector('p')?.textContent ?? '',
	path: card.dataset.path,
	current: card.hasAttribute('aria-current'),
})));

async function closeDialog(page) {
	await page.evaluate(() => document.getElementById('gallery-modal').close());
}

export default {
	name: 'local library',

	async setup(ctx) {
		const page = await ctx.newPage();
		await page.goto(ctx.server.url);
		await waitForColor(page, defaultPhoto.color);
		const file = (upload) => join(ctx.fixtures.uploads, upload.file);
		return { page, file };
	},

	tests: [
		['file picker adds photos, rejects broken files and shows the first one', async (ctx, { page, file }) => {
			await page.setFiles('#file-input', [file(UPLOADS.trip), file(UPLOADS.odd), file(UPLOADS.broken)]);
			assert.match(await waitForToast(page, /^(?!Adding)/), /Could not add broken\.jpg/);

			const cards = await localCards(page);
			assert.deepEqual(cards.map((card) => card.name).sort(), [UPLOADS.odd.name, UPLOADS.trip.name].sort());
			// Sizes come from the file header for 2:1 photos and from a full decode otherwise.
			const describe = (upload) => cards.find((card) => card.name === upload.name).description;
			assert.match(describe(UPLOADS.odd), new RegExp(`^${UPLOADS.odd.width}×${UPLOADS.odd.height} .*not 2:1`));
			assert.match(describe(UPLOADS.trip), new RegExp(`^${UPLOADS.trip.width}×${UPLOADS.trip.height} `));
			assert.doesNotMatch(describe(UPLOADS.trip), /not 2:1/);

			const trip = cards.find((card) => card.name === UPLOADS.trip.name);
			assert.match(trip.path, /^local:/);
			await waitForHash(page, trip.path);
			await waitForColor(page, UPLOADS.trip.color);
		}],

		['dropping a file shows the overlay; a duplicate re-opens the stored copy', async (ctx, { page, file }) => {
			await page.evaluate((path) => { location.hash = `panorama=${encodeURIComponent(path)}`; }, photoPath(PHOTOS[0]));
			await waitForColor(page, PHOTOS[0].color);

			await page.dragFiles([file(UPLOADS.trip)], { drop: false });
			await page.waitFor(() => page.evaluate(() => !document.getElementById('drop-overlay').hidden), { message: 'drop overlay' });
			await page.dragFiles([file(UPLOADS.trip)]);
			await waitForToast(page, /already on this device/);
			assert.equal(await page.evaluate(() => document.getElementById('drop-overlay').hidden), true);
			assert.equal((await localCards(page)).length, 2);
			await waitForColor(page, UPLOADS.trip.color);
		}],

		['library and local links survive a reload', async (ctx, { page }) => {
			const hash = await currentHash(page);
			await page.reload();
			await page.waitFor(async () => (await localCards(page)).length === 2, { message: 'local cards after reload' });
			assert.equal(await currentHash(page), hash);
			await waitForColor(page, UPLOADS.trip.color);
		}],

		['removing the photo being viewed switches to another one', async (ctx, { page }) => {
			await page.click('#open-gallery-btn');
			await page.waitFor(() => page.evaluate(() => document.getElementById('gallery-modal').open), { message: 'dialog' });
			await page.evaluate(() => document.querySelector('#local-grid .gallery-card[aria-current] .card-remove').click());
			await page.waitFor(async () => (await localCards(page)).length === 1, { message: 'card removal' });

			const [remaining] = await localCards(page);
			assert.equal(remaining.name, UPLOADS.odd.name);
			await waitForHash(page, remaining.path);
			await closeDialog(page);
			await waitForColor(page, UPLOADS.odd.color);
		}],

		['stale local links keep the current photo and explain why', async (ctx, { page }) => {
			const before = await currentHash(page);
			await page.evaluate(() => { location.hash = `panorama=${encodeURIComponent('local:missing')}`; });
			await waitForToast(page, /no longer stored on this device/);
			await page.waitFor(async () => (await currentHash(page)) === before, { message: 'hash to be restored' });
			await waitForColor(page, UPLOADS.odd.color);
		}],
	],
};
