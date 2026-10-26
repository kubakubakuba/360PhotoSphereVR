// VR flow on an emulated Quest 3 (IWER), with and without the WebXR layers polyfill.
// Positions below follow the layout constants in viewer.js / vr/gallery.js
// (head at 1.6 m, cards ~1.25 m ahead and 0.33 m below eye level).
import assert from 'node:assert/strict';
import { PHOTOS, photoPath } from '../lib/fixtures.mjs';
import { sleep } from '../lib/browser.mjs';
import { waitForColor, waitForDark, waitForHash } from '../lib/helpers.mjs';

const defaultPhoto = PHOTOS.find((photo) => photo.default);
const CARD_PICK = PHOTOS[2]; // top-right card on the first gallery page (3 columns)
const AFTER_PICK = PHOTOS[3]; // next photo after it
const QUEUE_PICK = PHOTOS[0]; // top-left card on the first page
const EYE = 1.6;
const TOP_ROW_Y = EYE - 0.33 + 0.114;
const AIM = {
	topRightCard: [0.37, TOP_ROW_Y, -0.3],
	topLeftCard: [-0.37, TOP_ROW_Y, -0.3],
	exitButton: [0.326, 1.03, -0.6],
};
const VR_TIMEOUT = 40000; // software rendering is slow

const controller = (page, code) => page.evaluate(`(() => { const c = window.xrDevice.controllers.right; ${code} })()`);

// Held long enough to span a frame even when software rendering is slow (~300 ms/frame).
async function press(page, button) {
	await controller(page, `c.updateButtonValue('${button}', 1);`);
	await sleep(400);
	await controller(page, `c.updateButtonValue('${button}', 0);`);
}

async function flickStick(page, x) {
	await controller(page, `c.updateAxes('thumbstick', ${x}, 0);`);
	await sleep(400);
	await controller(page, `c.updateAxes('thumbstick', 0, 0);`);
}

const aim = (page, [x, y, z]) => controller(page, `c.position.set(${x}, ${y}, ${z}); c.quaternion.set(0, 0, 0, 1);`);

// Positive degrees turn left, negative right.
const setYaw = (page, degrees) => page.evaluate((deg) => {
	const half = (deg * Math.PI) / 360;
	window.xrDevice.quaternion.set(0, Math.sin(half), 0, Math.cos(half));
}, degrees);

const gpu = (page) => page.evaluate(() => ({ live: window.__gpu.liveBig, peak: window.__gpu.peakBig }));

const vrStatus = (page) => page.evaluate(() => document.getElementById('vr-status-text').textContent);

// Enters VR and waits until the photo has expanded around the user (input is ignored mid-transition).
async function enterVr(page, photo) {
	await setYaw(page, 0);
	await page.click('#enter-vr');
	await page.waitFor(async () => (await vrStatus(page)) === 'In VR', { timeout: VR_TIMEOUT, message: 'VR session' });
	await waitForColor(page, photo.color, { at: [0.1, 0.5], timeout: VR_TIMEOUT });
	await waitForColor(page, photo.color);
}

async function exitVrFromGallery(page) {
	await press(page, 'b-button');
	await waitForDark(page, { at: [0.1, 0.5], timeout: VR_TIMEOUT });
	await aim(page, AIM.exitButton);
	await sleep(400);
	await press(page, 'trigger');
	await page.waitFor(() => page.evaluate(() => (
		!!document.querySelector('#panorama-viewer .psv-container')
		&& !document.getElementById('enter-vr').disabled
		&& document.getElementById('viewer').hidden
	)), { timeout: VR_TIMEOUT, message: 'desktop viewer to come back' });
}

// Switching photos must never hold more full-size textures than the steady state.
async function assertNoExtraGpuMemory(page, baseline, label) {
	const { live, peak } = await gpu(page);
	assert.ok(peak <= baseline, `${label}: ${peak} full-size textures alive at once, steady state is ${baseline}`);
	assert.ok(live <= baseline, `${label}: ${live} full-size textures still alive afterwards, steady state is ${baseline}`);
}

export function vrSpec({ layers }) {
	return {
		name: layers ? 'vr equirect layer' : 'vr sphere mesh',
		vr: true,

		async setup(ctx) {
			const page = await ctx.newPage({ vr: true, layers });
			await page.goto(ctx.server.url);
			await waitForColor(page, defaultPhoto.color);
			await page.waitFor(() => page.evaluate(() => !document.getElementById('enter-vr').disabled), { message: 'Enter VR button' });
			return { page, baseline: 0 };
		},

		tests: [
			['entering VR shows the photo in every direction', async (ctx, state) => {
				const { page } = state;
				await enterVr(page, defaultPhoto);
				const log = page.console.find((entry) => entry.text.startsWith('VR session:'))?.text ?? '';
				assert.match(log, layers ? /equirectLayer=true/ : /equirectLayer=false/);
				for (const yaw of [-90, 180, 90]) {
					await setYaw(page, yaw);
					await waitForColor(page, defaultPhoto.color, { timeout: 8000 });
				}
				await setYaw(page, 0);
				await sleep(500);
				state.baseline = (await gpu(page)).live;
			}],

			['B button opens the gallery in front of the user, over a dimmed background', async (ctx, { page }) => {
				await press(page, 'b-button');
				await waitForDark(page, { at: [0.1, 0.5], timeout: VR_TIMEOUT });
				await waitForColor(page, defaultPhoto.color, { timeout: 8000 }); // the photo orb, straight ahead
				// Turning away: the gallery and orb follow the gaze.
				await setYaw(page, -90);
				await waitForColor(page, defaultPhoto.color, { timeout: 10000 });
				await setYaw(page, 0);
				await waitForColor(page, defaultPhoto.color, { timeout: 10000 });
			}],

			['selecting a card loads that photo without extra GPU memory', async (ctx, { page, baseline }) => {
				const target = CARD_PICK;
				await page.evaluate(() => window.__gpu.resetPeak());
				await aim(page, AIM.topRightCard);
				await sleep(400);
				await press(page, 'trigger');
				await waitForHash(page, photoPath(target), VR_TIMEOUT);
				// Expanded around the user again: the photo covers the edge of the view, not just the orb.
				await waitForColor(page, target.color, { at: [0.1, 0.5], timeout: VR_TIMEOUT });
				await waitForColor(page, target.color);
				await setYaw(page, -90);
				await waitForColor(page, target.color, { timeout: 8000 });
				await setYaw(page, 0);
				await sleep(500);
				await assertNoExtraGpuMemory(page, baseline, 'gallery selection');
			}],

			['thumbstick flicks to the next photo', async (ctx, { page, baseline }) => {
				const target = AFTER_PICK;
				await page.evaluate(() => window.__gpu.resetPeak());
				await flickStick(page, 1);
				await waitForHash(page, photoPath(target), VR_TIMEOUT);
				await waitForColor(page, target.color, { at: [0.1, 0.5], timeout: VR_TIMEOUT });
				await waitForColor(page, target.color);
				await sleep(500);
				await assertNoExtraGpuMemory(page, baseline, 'thumbstick switch');
			}],

			['a press made during a transition is not lost', async (ctx, { page }) => {
				await press(page, 'b-button');
				await waitForDark(page, { at: [0.1, 0.5], timeout: VR_TIMEOUT });
				await aim(page, AIM.topLeftCard);
				await sleep(400);
				await press(page, 'trigger');
				await sleep(300); // the new photo is now loading
				await press(page, 'b-button');
				await waitForHash(page, photoPath(QUEUE_PICK), VR_TIMEOUT);
				// Once loaded, the queued B press reopens the gallery around the new photo's orb.
				await waitForColor(page, QUEUE_PICK.color, { timeout: VR_TIMEOUT });
				await waitForDark(page, { at: [0.1, 0.5], timeout: VR_TIMEOUT });
				await sleep(1500);
				await waitForDark(page, { at: [0.1, 0.5], timeout: 2000 });
				await press(page, 'b-button');
				await waitForColor(page, QUEUE_PICK.color, { at: [0.1, 0.5], timeout: VR_TIMEOUT });
			}],

			['Exit VR in the gallery returns to the desktop viewer on the same photo', async (ctx, { page }) => {
				await exitVrFromGallery(page);
				await waitForColor(page, QUEUE_PICK.color);
			}],

			['VR can be entered and left again', async (ctx, { page }) => {
				const current = QUEUE_PICK;
				await enterVr(page, current);
				await exitVrFromGallery(page);
				await waitForColor(page, current.color);
			}],
		],
	};
}
