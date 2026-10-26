import { decodePng, colorDistance, isDark } from './png.mjs';

export async function sampleAt(page, fx, fy, size) {
	return decodePng(await page.screenshot()).sample(fx, fy, size);
}

// Waits until the screen at (fx, fy) shows `expected` (RGB) within `tolerance`.
export async function waitForColor(page, expected, { at = [0.5, 0.5], tolerance = 40, timeout = 20000 } = {}) {
	let last = null;
	try {
		return await page.waitFor(async () => {
			last = await sampleAt(page, ...at);
			return colorDistance(last, expected) <= tolerance && last;
		}, { timeout, interval: 300 });
	} catch {
		throw new Error(`Expected rgb(${expected}) at ${at}, last saw rgb(${last})`);
	}
}

export async function waitForDark(page, { at = [0.5, 0.5], timeout = 10000 } = {}) {
	let last = null;
	try {
		return await page.waitFor(async () => {
			last = await sampleAt(page, ...at);
			return isDark(last) && last;
		}, { timeout, interval: 300 });
	} catch {
		throw new Error(`Expected a dark background at ${at}, last saw rgb(${last})`);
	}
}

export const currentHash = (page) => page.evaluate(() => decodeURIComponent(location.hash));

export async function waitForHash(page, path, timeout = 20000) {
	await page.waitFor(async () => (await currentHash(page)) === `#panorama=${path}`, { timeout, message: `hash #panorama=${path}` });
}

export async function waitForToast(page, pattern, timeout = 15000) {
	return page.waitFor(async () => {
		const text = await page.evaluate(() => {
			const toast = document.getElementById('toast');
			return toast.hidden ? '' : toast.textContent;
		});
		return pattern.test(text) && text;
	}, { timeout, message: `toast matching ${pattern}` });
}
