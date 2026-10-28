#!/usr/bin/env node
// End-to-end tests: desktop UI, local library and VR (emulated Quest 3) in headless Chromium.
//
//   node tests/e2e/run.mjs [filter...] [--headed] [--large]
//
//   filter    only run specs whose name contains one of the given words (e.g. "vr", "desktop")
//   --headed  show the browser window
//   --large   use 8192x4096 fixture panoramas (slower, closer to real photos)
//
// Requires Node >= 22 and Chromium/Chrome (set CHROME_BIN if it is not on PATH).
// Downloads the WebXR emulator scripts and renders fixtures once into tests/.cache/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';
import { startServer } from './lib/server.mjs';
import { ensureFixtures } from './lib/fixtures.mjs';
import { loadVendorScripts, emulatorScript } from './lib/vendor.mjs';
import desktop from './specs/desktop.mjs';
import localLibrary from './specs/local-library.mjs';
import imageSource from './specs/image-source.mjs';
import globe from './specs/globe.mjs';
import hotspots from './specs/hotspots.mjs';
import { vrSpec } from './specs/vr.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CACHE = join(HERE, '..', '.cache');
const ARTIFACTS = join(CACHE, 'artifacts');

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const large = args.includes('--large');
const filters = args.filter((arg) => !arg.startsWith('--'));

const ALL_SPECS = [desktop, localLibrary, imageSource, globe, hotspots, vrSpec({ layers: false }), vrSpec({ layers: true })];
const specs = ALL_SPECS.filter((spec) => filters.length === 0 || filters.some((filter) => spec.name.includes(filter)));

// Merges `overrides` into whatever config.js assigns to window.APP_CONFIG.
// Map tiles are off unless a test asks for them, so tests never reach the internet.
function configOverride(overrides) {
	const merged = JSON.stringify({ globeTileUrl: '', ...overrides });
	return `(() => {
		let value;
		Object.defineProperty(window, 'APP_CONFIG', {
			configurable: true,
			get: () => value,
			set: (config) => { value = { ...config, ...${merged} }; },
		});
	})();`;
}

const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = color(32);
const red = color(31);
const dim = color(2);

async function main() {
	if (specs.length === 0) {
		console.log(`No specs match ${filters.join(', ')}. Available: ${ALL_SPECS.map((s) => s.name).join(', ')}`);
		process.exit(1);
	}
	mkdirSync(ARTIFACTS, { recursive: true });

	const needsVr = specs.some((spec) => spec.vr);
	const vendor = needsVr ? await loadVendorScripts(join(CACHE, 'vendor')) : null;
	const gpuTracker = readFileSync(join(HERE, 'lib', 'gpu-tracker.js'), 'utf8');

	process.stdout.write(dim('Preparing fixtures… '));
	const renderer = await launchBrowser();
	await renderer.page.init();
	const fixtures = await ensureFixtures(renderer.page, join(CACHE, large ? 'fixtures-large' : 'fixtures'), { panoramaWidth: large ? 8192 : 4096 });
	await renderer.close();
	console.log(dim('done'));

	const server = await startServer({
		root: ROOT,
		mounts: {
			'/imgs/': fixtures.imgs,
			'/thumb/': fixtures.thumbs,
			'/uploads/': fixtures.uploads,
			'/tiles/': fixtures.tiles,
			'/gallery.json': fixtures.gallery,
		},
	});

	const results = [];
	for (const spec of specs) {
		console.log(`\n${spec.name}`);
		const browsers = [];
		const ctx = {
			server,
			fixtures,
			// config: overrides for config.js (window.APP_CONFIG)
			async newPage({ vr = false, layers = false, config = {} } = {}) {
				const browser = await launchBrowser({ headed });
				browsers.push(browser);
				await browser.page.init({ scripts: [gpuTracker, configOverride(config), ...(vr ? [emulatorScript(vendor, { layers })] : [])] });
				return browser.page;
			},
		};

		let state;
		let failed = false;
		try {
			state = await spec.setup?.(ctx);
		} catch (error) {
			failed = true;
			results.push({ spec: spec.name, test: 'setup', error });
			console.log(`  ${red('✗')} setup\n    ${red(error.message)}`);
		}

		for (const [title, fn] of spec.tests) {
			if (failed) {
				console.log(`  ${dim(`- ${title} (skipped)`)}`);
				results.push({ spec: spec.name, test: title, skipped: true });
				continue;
			}
			const start = Date.now();
			try {
				await fn(ctx, state);
				results.push({ spec: spec.name, test: title });
				console.log(`  ${green('✓')} ${title} ${dim(`(${((Date.now() - start) / 1000).toFixed(1)}s)`)}`);
			} catch (error) {
				failed = true; // later steps build on this one
				results.push({ spec: spec.name, test: title, error });
				console.log(`  ${red('✗')} ${title}\n    ${red(error.message)}`);
				const page = browsers.at(-1)?.page;
				if (page) {
					const file = join(ARTIFACTS, `${spec.name}-${title}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png');
					try {
						writeFileSync(file, await page.screenshot());
						console.log(dim(`    screenshot: ${file}`));
					} catch { /* page may be gone */ }
				}
			}
		}

		const errors = browsers.flatMap((browser) => browser.page.errors);
		if (!failed) {
			if (errors.length === 0) {
				console.log(`  ${green('✓')} no errors in the browser console`);
				results.push({ spec: spec.name, test: 'console' });
			} else {
				console.log(`  ${red('✗')} errors in the browser console:\n${errors.map((e) => `    ${red(e.split('\n')[0])}`).join('\n')}`);
				results.push({ spec: spec.name, test: 'console', error: new Error(errors.join('\n')) });
			}
		}
		await Promise.all(browsers.map((browser) => browser.close()));
	}

	await server.close();

	const failures = results.filter((result) => result.error);
	const skipped = results.filter((result) => result.skipped);
	const passed = results.length - failures.length - skipped.length;
	console.log(`\n${green(`${passed} passed`)}${failures.length ? `, ${red(`${failures.length} failed`)}` : ''}${skipped.length ? dim(`, ${skipped.length} skipped`) : ''}`);
	process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
	console.error(red(error.stack || error.message));
	process.exit(1);
});
