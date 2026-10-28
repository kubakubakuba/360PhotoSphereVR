import assert from 'node:assert/strict';
import { PHOTOS, photoPath } from '../lib/fixtures.mjs';
import { sleep } from '../lib/browser.mjs';
import { waitForColor, waitForHash, waitForToast } from '../lib/helpers.mjs';

const viewInHash = (page) => page.evaluate(() => {
	const params = new URLSearchParams(location.hash.slice(1));
	return params.has('yaw') ? { yaw: Number(params.get('yaw')), pitch: Number(params.get('pitch')), zoom: Number(params.get('zoom')) } : null;
});

const defaultPhoto = PHOTOS.find((photo) => photo.default);
const currentCardTitle = (page) => page.evaluate(() => document.querySelector('.gallery-card[aria-current] h3')?.textContent ?? null);
const dialogOpen = (page) => page.evaluate(() => document.getElementById('gallery-modal').open);

export default {
	name: 'desktop',

	async setup(ctx) {
		const page = await ctx.newPage();
		await page.goto(ctx.server.url);
		return { page };
	},

	tests: [
		['shows the gallery entry marked as default', async (ctx, { page }) => {
			await waitForColor(page, defaultPhoto.color);
			assert.equal(await page.waitFor(() => currentCardTitle(page), { message: 'current gallery card' }), defaultPhoto.name);
		}],

		['top bar shows the title without an icon and reports missing VR', async (ctx, { page }) => {
			const info = await page.evaluate(() => ({
				title: document.getElementById('app-title').textContent,
				photo: document.getElementById('photo-title').textContent,
				documentTitle: document.title,
				icon: !!document.querySelector('.brand svg'),
				enterDisabled: document.getElementById('enter-vr').disabled,
			}));
			assert.deepEqual(info, {
				title: '360° Photo Sphere',
				photo: defaultPhoto.name,
				documentTitle: `${defaultPhoto.name} – 360° Photo Sphere`,
				icon: false,
				enterDisabled: true,
			});
			const status = await page.waitFor(() => page.evaluate(() => {
				const pill = document.getElementById('vr-status');
				return pill.dataset.state !== 'pending' && pill.textContent.trim();
			}), { message: 'VR status' });
			assert.match(status, /No VR headset detected|WebXR not available/);
		}],

		['viewer controls are a floating pill', async (ctx, { page }) => {
			const navbar = await page.waitFor(() => page.evaluate(() => {
				const element = document.querySelector('#panorama-viewer .psv-navbar');
				if (!element) return null;
				return { radius: getComputedStyle(element).borderTopLeftRadius, width: element.getBoundingClientRect().width, viewport: innerWidth };
			}), { message: 'navbar' });
			assert.equal(navbar.radius, '999px');
			assert.ok(navbar.width < navbar.viewport / 2, `navbar spans ${navbar.width}px of ${navbar.viewport}px`);
		}],

		['gallery dialog lists the photos and closes with Escape', async (ctx, { page }) => {
			await page.click('#open-gallery-btn');
			await page.waitFor(() => dialogOpen(page), { message: 'dialog to open' });
			const content = await page.evaluate(() => ({
				server: document.querySelectorAll('#gallery-grid .gallery-card').length,
				local: document.querySelectorAll('#local-grid .gallery-card').length,
				addCard: !!document.querySelector('#local-grid .add-card'),
			}));
			assert.deepEqual(content, { server: PHOTOS.length, local: 0, addCard: true });
			await page.press('Escape', 'Escape', 27);
			await page.waitFor(async () => !(await dialogOpen(page)), { message: 'dialog to close' });
		}],

		['picking a photo in the gallery shows it', async (ctx, { page }) => {
			const target = PHOTOS[3];
			await page.click('#open-gallery-btn');
			await page.waitFor(() => dialogOpen(page), { message: 'dialog to open' });
			await page.click(`#gallery-grid .gallery-card[data-path="${photoPath(target)}"] .card-open`);
			await waitForHash(page, photoPath(target));
			assert.equal(await dialogOpen(page), false);
			await waitForColor(page, target.color);
			assert.equal(await currentCardTitle(page), target.name);
		}],

		['hash links switch the photo', async (ctx, { page }) => {
			const target = PHOTOS[4];
			await page.evaluate((path) => { location.hash = `panorama=${encodeURIComponent(path)}`; }, photoPath(target));
			await waitForColor(page, target.color);
		}],

		['a photo that loads clears the error of one that did not', async (ctx, { page }) => {
			const status = () => page.evaluate(() => document.getElementById('vr-status-text').textContent);
			await page.evaluate(() => { location.hash = 'panorama=./imgs/missing.jpg'; });
			await page.waitFor(async () => (await status()) === 'Could not load panorama', { message: 'error status' });
			const target = PHOTOS[4];
			await page.evaluate((path) => { location.hash = `panorama=${encodeURIComponent(path)}`; }, photoPath(target));
			await waitForColor(page, target.color);
			await page.waitFor(async () => /No VR headset detected|WebXR not available/.test(await status()), { message: 'status back to normal' });
			page.errors.length = 0; // the failed photo is logged on purpose
		}],

		['arrows and ←/→ keys step through photos, with the name in the top bar', async (ctx, { page }) => {
			const photoTitle = () => page.evaluate(() => document.getElementById('photo-title').textContent);
			const expect = async (photo) => {
				await waitForHash(page, photoPath(photo));
				await waitForColor(page, photo.color);
				assert.equal(await photoTitle(), photo.name);
			};
			await page.click('#next-photo');
			await expect(PHOTOS[5]);
			await page.click('#prev-photo');
			await expect(PHOTOS[4]);
			await page.press('ArrowRight', 'ArrowRight', 39);
			await expect(PHOTOS[5]);
			await page.press('ArrowRight', 'ArrowRight', 39);
			await expect(PHOTOS[6]);
			await page.press('ArrowRight', 'ArrowRight', 39); // wraps around
			await expect(PHOTOS[0]);
			await page.press('ArrowLeft', 'ArrowLeft', 37);
			await expect(PHOTOS[6]);
		}],

		['the link follows the view, and reopens on it', async (ctx, { page }) => {
			const mouse = (type, x, y) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
			await mouse('mousePressed', 640, 400);
			for (let i = 1; i <= 6; i++) await mouse('mouseMoved', 640 - i * 40, 400 + i * 10);
			await mouse('mouseReleased', 400, 460);
			const view = await page.waitFor(async () => {
				const current = await viewInHash(page);
				return current && Math.abs(current.yaw) > 5 && current;
			}, { message: 'the view in the link' });
			await page.reload();
			await waitForColor(page, PHOTOS[6].color);
			await sleep(800);
			const reopened = await viewInHash(page);
			assert.ok(reopened && Math.abs(reopened.yaw - view.yaw) < 0.5 && Math.abs(reopened.pitch - view.pitch) < 0.5, `${JSON.stringify(reopened)} ≈ ${JSON.stringify(view)}`);
		}],

		['the link button copies the link to this view', async (ctx, { page }) => {
			await page.evaluate(() => {
				navigator.clipboard.writeText = async (text) => { window.copied = text; };
			});
			await page.click('#copy-link-btn');
			await waitForToast(page, /Link copied/);
			assert.equal(await page.evaluate(() => window.copied === location.href && /&yaw=/.test(window.copied)), true);
		}],

		['M opens and closes the map', async (ctx, { page }) => {
			const mapOpen = () => page.evaluate(() => document.getElementById('globe-modal').open);
			await page.press('m', 'KeyM', 77);
			await page.waitFor(mapOpen, { message: 'map to open' });
			await sleep(300);
			await page.press('m', 'KeyM', 77);
			await page.waitFor(async () => !(await mapOpen()), { message: 'map to close' });
		}],

		['the preview shows while the full photo loads', async (ctx, { page }) => {
			const target = PHOTOS[3]; // has a preview
			const pill = () => page.evaluate(() => {
				const element = document.getElementById('hd-progress');
				return element.hidden ? null : element.textContent;
			});
			ctx.server.setDelay('/imgs/', 3000);
			try {
				await page.evaluate((path) => { location.hash = `panorama=${encodeURIComponent(path)}`; }, photoPath(target));
				await waitForColor(page, target.color, { timeout: 2500 }); // before the full photo can arrive
				assert.match(await pill(), /^Full resolution \d+ %$/);
			} finally {
				ctx.server.setDelay('/imgs/', 0);
			}
			await page.waitFor(async () => (await pill()) === null, { timeout: 15000, message: 'the full photo' });
			await waitForColor(page, target.color);
		}],
	],
};
