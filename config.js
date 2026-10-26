// Default runtime configuration.
// In Docker this file is regenerated from environment variables at container start
// (see docker/40-app-config.sh and .env.example).
window.APP_CONFIG = {
	title: '360° Photo Sphere',
	defaultPanorama: '', // empty = gallery entry marked "default", else the first entry
	galleryUrl: 'gallery.json',
	vrPassthrough: true, // use passthrough (immersive-ar) for the gallery / transitions when supported
	vrUseLayers: true, // show photos through a WebXR equirect layer (sharpest), falls back to a sphere mesh
	vrFoveation: 0, // 0 = full resolution everywhere, 1 = maximum fixed foveation
	vrFramebufferScale: 0, // 0 = device native (capped at 1.5)
	vrMaxTextureSize: 0, // 0 = 8192 (about the Quest 3 display resolution), capped by the GPU limit
};
