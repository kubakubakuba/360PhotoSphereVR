// Desktop map: the globe dialog, pins, preview card, map tiles and GPS positions from EXIF.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHOTOS, UPLOADS, TILE_COLOR, photoPath } from '../lib/fixtures.mjs';
import { exifSegment, withGps, xmpSegment } from '../lib/exif.mjs';
import { sleep } from '../lib/browser.mjs';
import { colorDistance } from '../lib/png.mjs';
import { sampleAt, waitForColor, waitForHash, waitForToast } from '../lib/helpers.mjs';

const defaultPhoto = PHOTOS.find((photo) => photo.default);
const geotagged = PHOTOS.filter((photo) => photo.lat !== undefined);
const PRAGUE = PHOTOS[0];
const PARIS = [PHOTOS[1], PHOTOS[2]]; // same place: one pin for both
const GEO_UPLOAD = { file: 'Geo Upload.jpg', name: 'Geo Upload', lat: -33.8568, lon: 151.2153 }; // southern / eastern hemisphere

const dialogOpen = (page) => page.evaluate(() => document.getElementById('globe-modal').open);
const stage = (page) => page.evaluate(() => {
	const element = document.getElementById('globe-stage');
	return { ...element.dataset, view: !!element.globeView };
});
const pins = (page) => page.evaluate(() => document.getElementById('globe-stage').globeView.pinPositions());
const setView = (page, view) => page.evaluate((v) => document.getElementById('globe-stage').globeView.globe.setView(v), view);

async function openMap(page) {
	await page.click('#open-globe-btn');
	await page.waitFor(async () => {
		const { view, ready } = await stage(page);
		return (await dialogOpen(page)) && view && ready === '1';
	}, { timeout: 20000, message: 'map with the Earth texture' });
	await sleep(300);
}

async function closeMap(page) {
	await page.evaluate(() => document.getElementById('globe-modal').close());
}

const mouse = (page, type, { x, y }) => page.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });

async function clickAt(page, point) {
	await mouse(page, 'mouseMoved', point);
	await sleep(300); // hover shows the preview first, like a real mouse
	await mouse(page, 'mousePressed', point);
	await mouse(page, 'mouseReleased', point);
}

async function pinFor(page, photo) {
	return page.waitFor(async () => (await pins(page)).find((pin) => pin.visible && pin.paths.includes(photoPath(photo))), { message: `visible pin for ${photo.name}` });
}

// Screen position as fractions, for sampleAt / waitForColor.
async function fraction(page, { x, y }) {
	const size = await page.evaluate(() => [innerWidth, innerHeight]);
	return [x / size[0], y / size[1]];
}

async function openTilesPage(ctx, globeTileUrl) {
	const page = await ctx.newPage({ config: { globeTileUrl, globeTileAttribution: 'Test tiles' } });
	await page.goto(ctx.server.url);
	await waitForColor(page, defaultPhoto.color);
	await openMap(page);
	return page;
}

export default {
	name: 'globe',

	async setup(ctx) {
		const page = await ctx.newPage();
		await page.goto(ctx.server.url);
		await waitForColor(page, defaultPhoto.color);
		return { page };
	},

	tests: [
		['the Map button shows when photos have GPS positions', async (ctx, { page }) => {
			assert.equal(await page.evaluate(() => document.getElementById('open-globe-btn').hidden), false);
		}],

		['the map opens on the current photo with a pin per place', async (ctx, { page }) => {
			await openMap(page);
			const all = await pins(page);
			// Prague (two photos 300 m apart), Paris (two photos), New York, Tokyo
			assert.equal(all.length, 4);
			assert.deepEqual(all.flatMap((pin) => pin.paths).sort(), geotagged.map(photoPath).sort());
			const paris = all.find((pin) => pin.paths.includes(photoPath(PARIS[0])));
			assert.deepEqual(paris.paths.sort(), PARIS.map(photoPath).sort());
			const center = await page.evaluate(() => {
				const rect = document.getElementById('globe-stage').getBoundingClientRect();
				return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
			});
			assert.ok(Math.hypot(paris.x - center.x, paris.y - center.y) < 3, 'the current photo is in the middle');
			const tokyo = all.find((pin) => pin.paths.includes(photoPath(PHOTOS[4])));
			assert.equal(tokyo.visible, false, 'pins on the far side are hidden');
		}],

		['hovering a pin previews the photo; clicking the orb opens it', async (ctx, { page }) => {
			const paris = await pinFor(page, PARIS[0]);
			await mouse(page, 'mouseMoved', paris);
			const card = await page.waitFor(() => page.evaluate(() => {
				const root = document.getElementById('globe-card');
				return !root.hidden && {
					title: document.getElementById('globe-card-title').textContent,
					count: document.getElementById('globe-card-count').textContent,
					action: document.getElementById('globe-card-action').textContent,
				};
			}), { message: 'photo card' });
			assert.ok(PARIS.some((photo) => photo.name === card.title), `card shows ${card.title}`);
			assert.match(card.count, /^[12] of 2 here$/);
			assert.equal(card.action, 'Click to open');
			// The spinning orb above the pin shows one of the photos taken there.
			const orbAt = await fraction(page, { x: paris.x, y: paris.y - 70 });
			await page.waitFor(async () => {
				const color = await sampleAt(page, ...orbAt);
				return PARIS.some((photo) => colorDistance(color, photo.color) < 50);
			}, { message: 'preview orb colour' });

			// Moving up onto the orb keeps the preview; clicking it opens the photo it shows.
			const orb = { x: paris.x, y: paris.y - 70 };
			await mouse(page, 'mouseMoved', orb);
			await sleep(300);
			const shown = await page.evaluate(() => !document.getElementById('globe-card').hidden && document.getElementById('globe-card-title').textContent);
			await mouse(page, 'mousePressed', orb);
			await mouse(page, 'mouseReleased', orb);
			const photo = PARIS.find((p) => p.name === shown);
			assert.ok(photo, `card still shows a Paris photo over the orb (${shown})`);
			await waitForHash(page, photoPath(photo));
			assert.equal(await dialogOpen(page), false);
			await waitForColor(page, photo.color);
		}],

		['clicking a single pin opens its photo', async (ctx, { page }) => {
			await openMap(page);
			await clickAt(page, await pinFor(page, PRAGUE));
			await waitForHash(page, photoPath(PRAGUE));
			assert.equal(await dialogOpen(page), false);
			await waitForColor(page, PRAGUE.color);
		}],

		['the map reopens where it was left', async (ctx, { page }) => {
			await openMap(page);
			await setView(page, { lat: 10, lon: 120, altitude: 0.5 });
			await sleep(1500); // saved while open, so also a reload keeps it
			await page.reload();
			await waitForColor(page, PRAGUE.color);
			await openMap(page);
			const view = await page.evaluate(() => ({ ...document.getElementById('globe-stage').globeView.globe.view }));
			assert.deepEqual([view.lat, view.lon, view.altitude].map((n) => Math.round(n * 100) / 100), [10, 120, 0.5]);
			await setView(page, { lat: 50, lon: 14, altitude: 1.2 });
			await closeMap(page);
		}],

		['dragging turns the globe and the wheel zooms', async (ctx, { page }) => {
			await openMap(page);
			const view = () => page.evaluate(() => ({ ...document.getElementById('globe-stage').globeView.globe.view }));
			const before = await view();
			const start = await page.evaluate(() => {
				const rect = document.getElementById('globe-stage').getBoundingClientRect();
				return { x: rect.left + rect.width / 2 + 60, y: rect.top + rect.height / 2 + 40 };
			});
			await mouse(page, 'mousePressed', start);
			for (let i = 1; i <= 5; i++) await mouse(page, 'mouseMoved', { x: start.x + i * 30, y: start.y });
			await mouse(page, 'mouseReleased', { x: start.x + 150, y: start.y });
			const dragged = await view();
			assert.ok(dragged.lon < before.lon - 5, `dragging right turns the globe east → west (lon ${before.lon} → ${dragged.lon})`);

			await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: start.x, y: start.y, deltaX: 0, deltaY: -200 });
			await page.waitFor(async () => (await view()).altitude < dragged.altitude * 0.8, { message: 'zoom in' });
			await closeMap(page);
		}],

		['the locate button goes to the current photo', async (ctx, { page }) => {
			await openMap(page);
			await setView(page, { lat: -40, lon: -120, altitude: 2 });
			await page.click('#globe-locate');
			const view = () => page.evaluate(() => ({ ...document.getElementById('globe-stage').globeView.globe.view }));
			await page.waitFor(async () => {
				const { lat, lon, altitude } = await view();
				return Math.abs(lat - PRAGUE.lat) < 0.01 && Math.abs(lon - PRAGUE.lon) < 0.01 && altitude <= 0.31;
			}, { message: 'the view on Prague' });
			await page.waitFor(() => page.evaluate(() => !document.getElementById('globe-card').hidden), { message: 'its card' });
			await closeMap(page);
		}],

		['"Show on map" in the gallery opens the map on that photo', async (ctx, { page }) => {
			const target = PHOTOS[3]; // New York
			await page.click('#open-gallery-btn');
			await page.click(`#gallery-grid .gallery-card[data-path="${photoPath(target)}"] .card-map`);
			// The card comes from the pin it flew to (a pin under the mouse may show first).
			await page.waitFor(async () => {
				const { view } = await stage(page);
				return view && (await page.evaluate((name) => {
					const card = document.getElementById('globe-card');
					return !card.hidden && document.getElementById('globe-card-title').textContent === name;
				}, target.name));
			}, { message: `the map with ${target.name}'s card` });
			const { lat, lon } = await page.evaluate(() => ({ ...document.getElementById('globe-stage').globeView.globe.view }));
			assert.ok(Math.abs(lat - target.lat) < 0.01 && Math.abs(lon - target.lon) < 0.01, `view on ${target.name} (${lat}, ${lon})`);
			assert.equal(await page.evaluate(() => document.getElementById('gallery-modal').open), false);
			await closeMap(page);
		}],

		['overlapping pins split when selected; ones that never split open a photo', async (ctx, { page }) => {
			const near = PHOTOS[3]; // moved next to Prague for this test
			const place = (photos) => page.evaluate((list) => {
				const view = document.getElementById('globe-stage').globeView;
				view.setItems(list, null);
				view.globe.setView({ lat: 50, lon: 15, altitude: 1.2 });
			}, photos.map(({ photo, lat, lon }) => ({ name: photo.name, path: photoPath(photo), lat, lon })));
			const both = [PRAGUE, near].map(photoPath).sort().join();
			const merged = async () => page.waitFor(async () => (await pins(page)).find((pin) => pin.visible && [...pin.paths].sort().join() === both), { message: 'one pin for both photos' });

			await openMap(page);
			// ~190 km apart: one pin from afar, two after selecting it.
			await place([{ photo: PRAGUE, lat: 50.087, lon: 14.421 }, { photo: near, lat: 49.195, lon: 16.608 }]);
			await clickAt(page, await merged());
			await page.waitFor(async () => (await pins(page)).filter((pin) => pin.visible && pin.paths.length === 1).length === 2, { timeout: 5000, message: 'the pin to split' });
			assert.equal(await dialogOpen(page), true, 'selecting a cluster zooms in instead of opening a photo');

			// ~55 m apart: closer than the built-in texture can zoom in, so the pin opens a photo.
			await place([{ photo: PRAGUE, lat: 50.087, lon: 14.421 }, { photo: near, lat: 50.0875, lon: 14.421 }]);
			await clickAt(page, await merged());
			await page.waitFor(async () => !(await dialogOpen(page)), { message: 'a photo to open' });
			assert.match(await page.evaluate(() => decodeURIComponent(location.hash)), new RegExp(`${photoPath(PRAGUE)}|${photoPath(near)}`.replaceAll('.', '\\.')));
		}],

		['map tiles cover the globe and stay when looking elsewhere', async (ctx) => {
			const page = await openTilesPage(ctx, `${ctx.server.url}tiles/tile.png?{z}/{x}/{y}`);
			const stageAt = (fx, fy) => page.evaluate(([x, y]) => {
				const rect = document.getElementById('globe-stage').getBoundingClientRect();
				return [(rect.left + rect.width * x) / innerWidth, (rect.top + rect.height * y) / innerHeight];
			}, [fx, fy]);
			// Ready tiles per level, and whether they are drawn.
			const tiles = () => page.evaluate(() => {
				const byLevel = {};
				for (const tile of document.getElementById('globe-stage').globeView.globe.tiles.tiles.values()) {
					if (tile.state === 'ready' && tile.mesh.visible) byLevel[tile.z] = (byLevel[tile.z] || 0) + 1;
				}
				return byLevel;
			});

			// Zoomed out, tiles cover the whole visible globe, also towards its edge.
			await waitForColor(page, TILE_COLOR, { at: await stageAt(0.5, 0.15) });
			await waitForColor(page, TILE_COLOR, { at: await stageAt(0.36, 0.5) });
			const attribution = await page.evaluate(() => {
				const element = document.getElementById('globe-attribution');
				return !element.hidden && element.textContent;
			});
			assert.equal(attribution, 'Test tiles');

			// Zoomed in over Paris, detail loads with coarser levels around it.
			await setView(page, { altitude: 0.01 });
			const detail = await page.waitFor(async () => {
				const levels = Object.keys(await tiles(page)).map(Number);
				return Math.max(...levels) >= 10 && Math.max(...levels);
			}, { message: 'detail tiles' });
			await page.waitFor(async () => (await tiles(page))[detail] >= 49, { message: 'the 7 × 7 detail tiles' });
			const levels = Object.keys(await tiles(page)).map(Number);
			assert.ok(levels.includes(detail - 2) && levels.includes(detail - 4), `coarser levels around the detail (${levels})`);
			await waitForColor(page, TILE_COLOR, { at: await stageAt(0.1, 0.9) });

			// Tokyo and back: the Paris tiles are still there, nothing to reload.
			const busy = () => page.evaluate(() => {
				const layer = document.getElementById('globe-stage').globeView.globe.tiles;
				return layer.queue.length + layer.loading;
			});
			await setView(page, { lat: 35.66, lon: 139.75 });
			await sleep(300);
			await page.waitFor(async () => (await busy()) === 0, { message: 'Tokyo tiles to load' });
			await setView(page, { lat: 48.8584, lon: 2.2945 });
			await sleep(300);
			assert.equal(await busy(), 0, 'returning to Paris requests no tiles');
			assert.ok((await tiles(page))[detail] >= 49);
		}],

		['without a network the built-in Earth texture stays', async (ctx) => {
			const page = await openTilesPage(ctx, 'http://127.0.0.1:9/{z}/{x}/{y}.png');
			await setView(page, { altitude: 0.01 });
			await page.waitFor(async () => (await stage(page)).tileState === 'offline', { message: 'tiles to be given up' });
			await sleep(300);
			const { tiles } = await stage(page);
			const altitude = await page.evaluate(() => document.getElementById('globe-stage').globeView.globe.view.altitude);
			assert.equal(tiles, '0');
			assert.ok(altitude > 0.05, `zoom is limited to the built-in texture's detail (altitude ${altitude})`);
			assert.ok(page.console.some((entry) => entry.type === 'warning' && /Map tiles unavailable/.test(entry.text)));
		}],

		['GPS positions are read from JPEG EXIF', async (ctx, { page }) => {
			const cases = [
				{ lat: 50.087, lon: 14.421, littleEndian: true },
				{ lat: -33.8568, lon: -70.6483, littleEndian: false },
			];
			for (const { lat, lon, littleEndian } of cases) {
				const jpeg = [...withGps(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), lat, lon, { littleEndian })];
				const gps = await page.evaluate(async (bytes) => {
					const { readGps } = await import('./vr/exif-gps.js');
					return readGps(new Blob([new Uint8Array(bytes)]));
				}, jpeg);
				assert.ok(Math.abs(gps.lat - lat) < 1e-5 && Math.abs(gps.lon - lon) < 1e-5, `${JSON.stringify(gps)} ≈ ${lat}, ${lon}`);
			}
			const none = await page.evaluate(async (bytes) => {
				const { readGps } = await import('./vr/exif-gps.js');
				return readGps(new Blob([new Uint8Array(bytes)]));
			}, [0xff, 0xd8, ...exifSegment(0, 0), 0xff, 0xd9]);
			assert.equal(none, null, '0 / 0 means no fix');

			// DJI's heading (gimbal yaw, else flight yaw) and height come from the XMP.
			const xmp = '<x:xmpmeta><rdf:Description drone-dji:RelativeAltitude="+120.40" drone-dji:GimbalYawDegree="-35.70" '
				+ 'drone-dji:FlightYawDegree="+10.00"/></x:xmpmeta>';
			const metadata = await page.evaluate(async (bytes) => {
				const { readPhotoMetadata } = await import('./vr/exif-gps.js');
				return readPhotoMetadata(new Blob([new Uint8Array(bytes)]));
			}, [0xff, 0xd8, ...exifSegment(50.087, 14.421), ...xmpSegment(xmp), 0xff, 0xd9]);
			assert.deepEqual(metadata, { lat: 50.087, lon: 14.421, heading: 324.3, height: 120.4 });
		}],

		['photos added on this device appear on the map', async (ctx, { page }) => {
			const file = join(ctx.fixtures.uploads, GEO_UPLOAD.file);
			writeFileSync(file, withGps(readFileSync(join(ctx.fixtures.uploads, UPLOADS.trip.file)), GEO_UPLOAD.lat, GEO_UPLOAD.lon));
			await page.setFiles('#file-input', [file]);
			await waitForToast(page, /saved on this device/);
			await waitForColor(page, UPLOADS.trip.color);
			const path = await page.evaluate(() => decodeURIComponent(location.hash).replace('#panorama=', ''));
			assert.match(path, /^local:/);

			await openMap(page);
			await page.waitFor(async () => (await pins(page)).find((p) => p.paths.includes(path)), { message: 'pin for the added photo' });
			await closeMap(page);

			// Still there after a reload (read back from IndexedDB).
			await page.reload();
			await waitForColor(page, UPLOADS.trip.color);
			await openMap(page);
			assert.ok((await pins(page)).some((p) => p.paths.includes(path)));
			await closeMap(page);
		}],
	],
};
