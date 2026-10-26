// Downloads (once) the WebXR emulation scripts used by the VR tests.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = {
	// Meta's Immersive Web Emulation Runtime: emulates a Quest 3 headset and controllers.
	iwer: 'https://cdn.jsdelivr.net/npm/iwer@2.6.0/build/iwer.min.js',
	// WebXR Layers polyfill, so the equirect layer code path can run in a desktop browser.
	layers: 'https://cdn.jsdelivr.net/npm/webxr-layers-polyfill@1.1.0/build/webxr-layers-polyfill.min.js',
};

export async function loadVendorScripts(dir) {
	mkdirSync(dir, { recursive: true });
	const scripts = {};
	for (const [name, url] of Object.entries(SCRIPTS)) {
		const file = join(dir, url.split('/').slice(-3).join('_'));
		if (!existsSync(file)) {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
			writeFileSync(file, await response.text());
		}
		scripts[name] = readFileSync(file, 'utf8');
	}
	return scripts;
}

// The polyfill's layer.destroy() forgets its textures without deleting them, unlike real
// runtimes which free the swapchain. Delete them so GPU memory assertions see real behaviour.
const RELEASE_LAYER_TEXTURES = `;(() => {
	const create = XRWebGLBinding.prototype.createEquirectLayer;
	XRWebGLBinding.prototype.createEquirectLayer = function (...args) {
		const layer = create.apply(this, args);
		const destroy = layer.destroy.bind(layer);
		layer.destroy = () => {
			for (const texture of layer._colorTextures || []) layer.context?.deleteTexture(texture);
			destroy();
		};
		return layer;
	};
})();`;

// Page script installing an emulated Quest 3 (optionally with the layers polyfill).
export function emulatorScript(scripts, { layers = false } = {}) {
	return [
		scripts.iwer,
		';(() => { const device = new IWER.XRDevice(IWER.metaQuest3); device.installRuntime({ forceInstall: true }); window.xrDevice = device; })();',
		layers ? `${scripts.layers}\n;new WebXRLayersPolyfill();\n${RELEASE_LAYER_TEXTURES}` : '',
	].join('\n');
}
