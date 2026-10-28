import { Viewer as PhotoSphereViewer } from '@photo-sphere-viewer/core';
import { LocalLibrary } from './local-library.js';
import { itemCoordinates } from './vr/geo.js';
import { PanoramaHotspots } from './panorama-hotspots.js';
import { hasHotspots, hotspotsVisible, setHotspotsVisible } from './vr/hotspots.js';
import { previewUrl, downloadBlob } from './vr/image-source.js';

const DEFAULT_CONFIG = {
	title: '360° Photo Sphere',
	defaultPanorama: '',
	galleryUrl: 'gallery.json',
	vrPassthrough: true,
	vrUseLayers: true,
	vrFoveation: 0,
	vrFramebufferScale: 0,
	vrMaxTextureSize: 0,
	globe: true,
	globeTileUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
	globeTileAttribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
	globeTileMaxZoom: 17,
	hotspots: true,
	hotspotMaxDistance: 5000,
};
const config = { ...DEFAULT_CONFIG, ...(window.APP_CONFIG || {}) };
const FALLBACK_PANORAMA = 'DEFAULT.JPG';
const PLACEHOLDER_THUMBNAIL = 'placeholder_thumbnail.png';
const EXIT_TIMEOUT_MS = 2000;
const PANORAMA_ERROR = 'Could not load panorama';
const VIEW_HASH_DELAY_MS = 300;
const DEG = Math.PI / 180;

let panoramaViewer = null;
let hotspots = null;
let loadGeneration = 0; // the latest showPanorama; older loads give way
let shownObjectUrl = null; // the downloaded full photo on screen, revoked once replaced
let viewHashTimer = null;
let vrViewer = null;
let vrSession = null;
let viewerModule = null;
let globeModule = null;
let globeView = null;
let exitFallbackTimer = null;
let galleryItems = [];
let currentPanorama = null;
let toastTimer = null;
const xrSupport = { vr: false, ar: false };
const library = new LocalLibrary();

const $ = (id) => document.getElementById(id);
const els = {
	title: $('app-title'),
	panorama: $('panorama-viewer'),
	vr: $('viewer'),
	enterVr: $('enter-vr'),
	openGallery: $('open-gallery-btn'),
	status: $('vr-status'),
	statusText: $('vr-status-text'),
	loading: $('vr-loading'),
	loadingText: $('loading-text'),
	progress: $('progress-bar'),
	modal: $('gallery-modal'),
	modalClose: $('gallery-close'),
	openGlobe: $('open-globe-btn'),
	globeModal: $('globe-modal'),
	globeClose: $('globe-close'),
	globeStage: $('globe-stage'),
	globeAttribution: $('globe-attribution'),
	globeZoomIn: $('globe-zoom-in'),
	globeZoomOut: $('globe-zoom-out'),
	globeCard: $('globe-card'),
	globeCardTitle: $('globe-card-title'),
	globeCardDescription: $('globe-card-description'),
	globeCardCount: $('globe-card-count'),
	globeCardAction: $('globe-card-action'),
	grid: $('gallery-grid'),
	localGrid: $('local-grid'),
	fileInput: $('file-input'),
	dropOverlay: $('drop-overlay'),
	toast: $('toast'),
	photoTitle: $('photo-title'),
	prevPhoto: $('prev-photo'),
	nextPhoto: $('next-photo'),
	copyLink: $('copy-link-btn'),
	toggleHotspots: $('toggle-hotspots-btn'),
	hdProgress: $('hd-progress'),
	globeLocate: $('globe-locate'),
};

const ICONS = {
	add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
	remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
	map: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/></svg>',
};

// --- Helpers ------------------------------------------------------------

function panoramaFromHash() {
	return new URLSearchParams(window.location.hash.slice(1)).get('panorama');
}

// View direction in the link: #panorama=…&yaw=<°>&pitch=<°>&zoom=<0–100>.
function viewFromHash() {
	const params = new URLSearchParams(window.location.hash.slice(1));
	const number = (key) => {
		const value = params.get(key);
		return value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
	};
	return { yaw: number('yaw'), pitch: number('pitch'), zoom: number('zoom') };
}

function panoramaHash(path) {
	return `#panorama=${encodeURIComponent(path)}`;
}

// Keeps the link pointing at what is on screen (replaceState: no hashchange, no history entries).
function writeViewToHash() {
	clearTimeout(viewHashTimer);
	if (!panoramaViewer || !currentPanorama || panoramaFromHash() !== currentPanorama) return;
	const { yaw, pitch } = panoramaViewer.getPosition();
	const round = (value) => Math.round(value * 10) / 10;
	const yawDegrees = round(Math.atan2(Math.sin(yaw), Math.cos(yaw)) / DEG);
	const zoom = Math.round(panoramaViewer.getZoomLevel());
	history.replaceState(null, '', `${panoramaHash(currentPanorama)}&yaw=${yawDegrees}&pitch=${round(pitch / DEG)}&zoom=${zoom}`);
}

function scheduleViewHash() {
	clearTimeout(viewHashTimer);
	viewHashTimer = setTimeout(writeViewToHash, VIEW_HASH_DELAY_MS);
}

function viewOptions({ yaw, pitch, zoom } = {}) {
	const options = {};
	if (yaw !== null && yaw !== undefined) options.position = { yaw: yaw * DEG, pitch: (pitch ?? 0) * DEG };
	if (zoom !== null && zoom !== undefined) options.zoom = Math.min(100, Math.max(0, zoom));
	return options;
}

async function copyLink() {
	writeViewToHash();
	try {
		await navigator.clipboard.writeText(window.location.href);
		showToast('Link copied.');
	} catch (error) {
		console.warn('Could not copy the link:', error);
		showToast('Could not copy the link.', 'error');
	}
}

function setStatus(state, text) {
	els.status.dataset.state = state;
	els.statusText.textContent = text;
	els.status.title = text;
}

function showLoading(text, percent) {
	els.loadingText.textContent = text;
	els.progress.style.width = `${percent}%`;
	els.loading.hidden = false;
}

function hideLoading() {
	els.loading.hidden = true;
}

function showToast(text, kind = 'info', duration = 3500) {
	clearTimeout(toastTimer);
	els.toast.textContent = text;
	els.toast.dataset.kind = kind;
	els.toast.hidden = false;
	toastTimer = setTimeout(() => { els.toast.hidden = true; }, duration);
}

// local:<id> paths point into the on-device library; everything else is a URL.
function resolveUrl(path) {
	return library.resolve(path) ?? path;
}

function allItems() {
	return [...library.items, ...galleryItems];
}

function isAvailable(path) {
	return !!path && (!LocalLibrary.isLocal(path) || library.has(path));
}

async function loadGallery() {
	try {
		const response = await fetch(config.galleryUrl, { cache: 'no-cache' });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();
		return Array.isArray(data) ? data.filter((item) => item && item.path) : [];
	} catch (error) {
		console.error('Could not load gallery:', error);
		return [];
	}
}

function resolveDefaultPanorama() {
	return config.defaultPanorama
		|| galleryItems.find((item) => item.default)?.path
		|| galleryItems[0]?.path
		|| FALLBACK_PANORAMA;
}

// --- Desktop panorama viewer --------------------------------------------

function initPanoramaViewer(path, view = {}) {
	const compact = window.innerWidth < 600;
	panoramaViewer = new PhotoSphereViewer({
		container: els.panorama,
		navbar: compact ? ['zoom', 'fullscreen'] : ['zoom', 'move', 'fullscreen'],
		defaultYaw: (view.yaw ?? 0) * DEG,
		defaultPitch: (view.pitch ?? 0) * DEG,
		defaultZoomLvl: view.zoom ?? 0,
		minFov: 30,
		maxFov: 90,
		mousewheel: true,
		keyboard: 'fullscreen',
		loadingTxt: '',
	});
	panoramaViewer.addEventListener('panorama-error', (event) => {
		console.error('Panorama failed to load:', event.error);
		setStatus('error', PANORAMA_ERROR);
	});
	// A photo that loads clears the error of one that didn't.
	panoramaViewer.addEventListener('panorama-loaded', () => {
		if (els.statusText.textContent === PANORAMA_ERROR) showXrStatus();
		hotspots?.show(itemFor(currentPanorama), allItems());
	});
	panoramaViewer.addEventListener('position-updated', scheduleViewHash);
	panoramaViewer.addEventListener('zoom-updated', scheduleViewHash);
	if (config.hotspots !== false) {
		hotspots = new PanoramaHotspots({
			viewer: panoramaViewer,
			maxDistance: Number(config.hotspotMaxDistance) || 5000,
			onSelect: (target) => { window.location.hash = panoramaHash(target); },
		});
		hotspots.setVisible(hotspotsVisible());
	}
	refreshHotspotsToggle(); // VR may have changed the setting
	loadPanorama(path, { transition: false });
}

function destroyPanoramaViewer() {
	loadGeneration++;
	setHdProgress(null);
	hotspots?.destroy();
	hotspots = null;
	panoramaViewer?.destroy();
	panoramaViewer = null;
	if (shownObjectUrl) URL.revokeObjectURL(shownObjectUrl);
	shownObjectUrl = null;
}

function showPanorama(path, view = {}) {
	if (!path || path === currentPanorama) return;
	if (!isAvailable(path)) {
		showToast('That photo is no longer stored on this device.', 'error');
		history.replaceState(null, '', panoramaHash(currentPanorama));
		return;
	}
	currentPanorama = path;
	refreshCurrentPhoto();
	if (panoramaViewer) loadPanorama(path, { ...viewOptions(view), transition: 800 });
}

function itemFor(path) {
	return allItems().find((item) => item.path === path) ?? null;
}

// Preview first (about a second) while the full photo downloads alongside; it then replaces the
// preview without changing the view.
async function loadPanorama(path, options) {
	const generation = ++loadGeneration;
	const current = () => generation === loadGeneration && panoramaViewer;
	const preview = previewUrl(itemFor(path));
	const full = resolveUrl(path);
	if (!preview) {
		setHdProgress(null);
		if (full.startsWith('blob:')) {
			await showFull(full, { ...options, showLoader: true }, current);
			return;
		}
		// Downloaded here rather than by the viewer, so sealed (.pano) photos get unsealed first.
		panoramaViewer.loader.showUndefined();
		let blob = null;
		try {
			blob = await downloadBlob(full, (progress) => current() && panoramaViewer.loader.setProgress(progress * 100));
		} catch (error) {
			console.warn('Download failed, leaving it to the viewer:', error);
		}
		if (!current()) return;
		await showFull(blob ? URL.createObjectURL(blob) : full, { ...options, showLoader: true }, current, !!blob);
		return;
	}

	setHdProgress(0);
	// Local photos are already in memory (blob: URLs); others download with progress.
	const download = full.startsWith('blob:')
		? Promise.resolve(null)
		: downloadBlob(full, (progress) => current() && setHdProgress(progress * 100));
	download.catch(() => {}); // handled below
	try {
		await panoramaViewer.setPanorama(preview, { ...options, showLoader: false });
	} catch (error) {
		if (!current()) return;
		console.warn('Preview failed to load, waiting for the full photo:', error);
	}
	let blob = null;
	try {
		blob = await download;
	} catch (error) {
		console.warn('Download failed, leaving it to the viewer:', error); // which then reports it
	}
	if (!current()) return;
	await showFull(blob ? URL.createObjectURL(blob) : full, { transition: false, showLoader: false }, current, !!blob);
	if (generation === loadGeneration) setHdProgress(null);
}

// owned: an object URL made here, released once something else is shown.
async function showFull(url, options, current, owned = false) {
	let shown = false;
	try {
		await panoramaViewer.setPanorama(url, options);
		shown = !!current();
	} catch (error) {
		if (current()) console.error('setPanorama failed:', error);
	}
	if (!shown) {
		if (owned) URL.revokeObjectURL(url);
		return;
	}
	if (shownObjectUrl) URL.revokeObjectURL(shownObjectUrl);
	shownObjectUrl = owned ? url : null;
}

// "Full resolution 45 %" while the full photo replaces the preview; null hides it.
function setHdProgress(percent) {
	els.hdProgress.hidden = percent === null;
	if (percent !== null) els.hdProgress.textContent = `Full resolution ${Math.round(percent)} %`;
}

// --- Gallery modal ------------------------------------------------------

function createGalleryCard(item) {
	const card = document.createElement('div');
	card.className = 'gallery-card';
	card.dataset.path = item.path;

	const open = document.createElement('button');
	open.type = 'button';
	open.className = 'card-open';

	const img = document.createElement('img');
	img.loading = 'lazy';
	img.decoding = 'async';
	img.alt = '';
	img.src = item.thumbnail || PLACEHOLDER_THUMBNAIL;
	img.addEventListener('error', () => {
		if (!img.src.endsWith(PLACEHOLDER_THUMBNAIL)) img.src = PLACEHOLDER_THUMBNAIL;
	}, { once: true });

	const meta = document.createElement('div');
	meta.className = 'meta';
	const title = document.createElement('h3');
	title.textContent = item.name || item.path.split('/').pop();
	meta.append(title);
	if (item.description) {
		const description = document.createElement('p');
		description.textContent = item.description;
		meta.append(description);
	}

	open.append(img, meta);
	open.addEventListener('click', () => {
		window.location.hash = `panorama=${encodeURIComponent(item.path)}`;
		els.modal.close();
	});
	card.append(open);

	if (config.globe !== false && itemCoordinates(item)) {
		const locate = document.createElement('button');
		locate.type = 'button';
		locate.className = 'card-action card-map';
		locate.title = 'Show on map';
		locate.setAttribute('aria-label', `Show ${title.textContent} on the map`);
		locate.innerHTML = ICONS.map;
		locate.addEventListener('click', () => openGlobeModal({ focus: item.path }));
		card.append(locate);
	}

	if (item.local) {
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'card-action card-remove';
		remove.title = 'Remove from this device';
		remove.setAttribute('aria-label', `Remove ${title.textContent} from this device`);
		remove.innerHTML = ICONS.remove;
		remove.addEventListener('click', () => removeLocalPhoto(item.path));
		card.append(remove);
	}
	return card;
}

function createAddCard() {
	const card = document.createElement('button');
	card.type = 'button';
	card.className = 'add-card';
	card.innerHTML = `${ICONS.add}<strong>Add photos</strong><span>Drop files here or click to browse. They stay in this browser.</span>`;
	card.addEventListener('click', () => els.fileInput.click());
	return card;
}

function renderGallery() {
	els.localGrid.replaceChildren(createAddCard(), ...library.items.map(createGalleryCard));

	if (galleryItems.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'gallery-empty';
		empty.textContent = 'No panoramas found. Check gallery.json.';
		els.grid.replaceChildren(empty);
	} else {
		els.grid.replaceChildren(...galleryItems.map(createGalleryCard));
	}
	refreshCurrentPhoto();
	els.openGlobe.hidden = !globeAvailable();
	refreshHotspotsToggle();
	globeView?.setItems(allItems(), currentPanorama);
}

// --- Markers to nearby photos ---------------------------------------------

function refreshHotspotsToggle() {
	els.toggleHotspots.hidden = config.hotspots === false || !hasHotspots(allItems());
	els.toggleHotspots.setAttribute('aria-pressed', String(hotspotsVisible()));
}

function toggleHotspots() {
	setHotspotsVisible(!hotspotsVisible());
	hotspots?.setVisible(hotspotsVisible());
	refreshHotspotsToggle();
	showToast(hotspotsVisible() ? 'Markers to nearby photos shown' : 'Markers to nearby photos hidden', 'info', 1800);
}

function photoName(path) {
	const item = allItems().find((entry) => entry.path === path);
	if (item?.name) return item.name;
	return path && !LocalLibrary.isLocal(path) ? decodeURIComponent(path.split('/').pop()) : '';
}

// Updates everything that depends on the current photo: gallery marking, title, arrows.
function refreshCurrentPhoto() {
	for (const card of els.modal.querySelectorAll('.gallery-card')) {
		card.toggleAttribute('aria-current', card.dataset.path === currentPanorama);
	}
	const name = photoName(currentPanorama);
	els.photoTitle.textContent = name;
	els.photoTitle.hidden = !name;
	document.title = name ? `${name} – ${config.title}` : config.title;
	const navigable = allItems().length > 1;
	els.prevPhoto.hidden = !navigable;
	els.nextPhoto.hidden = !navigable;
}

// Same order as the VR thumbstick: local photos first, then the gallery; wraps around.
function stepPhoto(direction) {
	const items = allItems();
	if (items.length < 2) return;
	const index = items.findIndex((item) => item.path === currentPanorama);
	const next = index < 0
		? items[direction > 0 ? 0 : items.length - 1]
		: items[(index + direction + items.length) % items.length];
	window.location.hash = `panorama=${encodeURIComponent(next.path)}`;
}

// ←/→ step through photos, M opens / closes the map, H shows / hides the markers.
function onKeyDown(event) {
	if (vrSession || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
	if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
	// In fullscreen the arrow keys rotate the view (Photo Sphere Viewer keyboard control).
	if (els.modal.open || document.fullscreenElement) return;
	if (event.code === 'KeyM' && !event.repeat) {
		if (els.globeModal.open) els.globeModal.close();
		else if (globeAvailable()) openGlobeModal();
		return;
	}
	if (event.code === 'KeyH' && !event.repeat) {
		if (!els.toggleHotspots.hidden && !els.globeModal.open) toggleHotspots();
		return;
	}
	if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || els.globeModal.open) return;
	event.preventDefault();
	stepPhoto(event.key === 'ArrowRight' ? 1 : -1);
}

// A pasted link for the photo already shown only turns the view.
function onHashChange() {
	const path = panoramaFromHash();
	const view = viewFromHash();
	if (path && path !== currentPanorama) {
		showPanorama(path, view);
		return;
	}
	const { position, zoom } = viewOptions(view);
	if (position) panoramaViewer?.rotate(position);
	if (zoom !== undefined) panoramaViewer?.zoom(zoom);
}

function openGalleryModal() {
	els.modal.showModal();
	els.modal.querySelector('.gallery-card[aria-current]')?.scrollIntoView({ block: 'nearest' });
}

// --- Map ----------------------------------------------------------------

function globeAvailable() {
	return config.globe !== false && allItems().some((item) => itemCoordinates(item));
}

// focus: a photo to fly to and preview, instead of the view the map was left at.
async function openGlobeModal({ focus } = {}) {
	if (els.modal.open) els.modal.close();
	if (!els.globeModal.open) els.globeModal.showModal();
	try {
		const { GlobeView } = await (globeModule ??= import('./globe-view.js'));
		if (!els.globeModal.open) return;
		if (globeView) {
			if (focus) globeView.focus(focus);
			return;
		}
		globeView = new GlobeView({
			stage: els.globeStage,
			card: {
				root: els.globeCard,
				title: els.globeCardTitle,
				description: els.globeCardDescription,
				count: els.globeCardCount,
				action: els.globeCardAction,
			},
			attribution: els.globeAttribution,
			zoom: { in: els.globeZoomIn, out: els.globeZoomOut, locate: els.globeLocate },
			items: allItems(),
			current: currentPanorama,
			config,
			resolveUrl,
			onOpen: (path) => {
				window.location.hash = `panorama=${encodeURIComponent(path)}`;
				els.globeModal.close();
			},
		});
		if (focus) globeView.focus(focus);
	} catch (error) {
		console.error('Could not open the map:', error);
		showToast('Could not open the map.', 'error');
		els.globeModal.close();
	}
}

// The close event arrives a task later: the map may have been opened again in between.
function closeGlobeView() {
	if (els.globeModal.open) return;
	globeView?.destroy();
	globeView = null;
}

// --- Local photos -------------------------------------------------------

async function addLocalPhotos(files) {
	const images = [...files];
	if (images.length === 0) return;
	showToast(images.length === 1 ? `Adding ${images[0].name}…` : `Adding ${images.length} photos…`, 'info', 60000);

	const { added, existing, failed } = await library.add(images);
	renderGallery();

	const first = added[0] || existing[0];
	if (first) {
		window.location.hash = `panorama=${encodeURIComponent(first)}`;
		if (els.modal.open) els.modal.close();
	}
	if (failed.length > 0) {
		const names = failed.map((f) => `${f.name} (${f.reason})`).join(', ');
		showToast(`Could not add ${names}`, 'error', 6000);
	} else if (added.length > 0) {
		const where = library.persistent ? 'saved on this device' : 'available until you close this tab';
		showToast(`${added.length === 1 ? 'Photo' : `${added.length} photos`} ${where}.`);
	} else if (existing.length > 0) {
		showToast(existing.length === 1 ? 'That photo is already on this device.' : 'Those photos are already on this device.');
	} else {
		els.toast.hidden = true;
	}
}

async function removeLocalPhoto(path) {
	try {
		await library.remove(path);
	} catch (error) {
		console.error('Could not remove local photo:', error);
		showToast('Could not remove the photo.', 'error');
		return;
	}
	if (path === currentPanorama) {
		const fallback = library.items[0]?.path || resolveDefaultPanorama();
		window.location.hash = `panorama=${encodeURIComponent(fallback)}`;
	}
	renderGallery();
}

function setupDragAndDrop() {
	const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
	let depth = 0;

	window.addEventListener('dragenter', (event) => {
		if (!hasFiles(event) || vrSession) return;
		depth++;
		els.dropOverlay.hidden = false;
	});
	window.addEventListener('dragleave', (event) => {
		if (!hasFiles(event)) return;
		depth = Math.max(0, depth - 1);
		if (depth === 0) els.dropOverlay.hidden = true;
	});
	window.addEventListener('dragover', (event) => {
		if (!hasFiles(event)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
	});
	window.addEventListener('drop', (event) => {
		if (!hasFiles(event)) return;
		event.preventDefault();
		depth = 0;
		els.dropOverlay.hidden = true;
		if (!vrSession) addLocalPhotos(event.dataTransfer.files);
	});

	els.fileInput.addEventListener('change', () => {
		addLocalPhotos(els.fileInput.files);
		els.fileInput.value = '';
	});
}

// --- WebXR --------------------------------------------------------------

async function detectXrSupport() {
	if (navigator.xr) {
		const check = (mode) => navigator.xr.isSessionSupported(mode).catch(() => false);
		[xrSupport.vr, xrSupport.ar] = await Promise.all([check('immersive-vr'), check('immersive-ar')]);
	}
	if (xrSupport.vr || xrSupport.ar) {
		els.enterVr.disabled = false;
		viewerModule ??= import('./viewer.js'); // warm up so entering VR is instant
	}
	showXrStatus();
}

function showXrStatus() {
	if (!navigator.xr) setStatus('idle', window.isSecureContext ? 'WebXR not available' : 'VR requires HTTPS');
	else if (xrSupport.vr || xrSupport.ar) setStatus('ok', 'VR ready');
	else setStatus('idle', 'No VR headset detected');
}

async function enterVR() {
	if (vrSession || !navigator.xr) return;
	els.enterVr.disabled = true;

	const mode = config.vrPassthrough && xrSupport.ar ? 'immersive-ar' : 'immersive-vr';
	let session;
	try {
		// Request the session first, while the click still counts as a user gesture.
		session = await navigator.xr.requestSession(mode, { optionalFeatures: ['local-floor', 'layers', 'hand-tracking'] });
	} catch (error) {
		console.error('Could not start XR session:', error);
		setStatus('error', `Could not start VR: ${error.message}`);
		els.enterVr.disabled = false;
		return;
	}

	vrSession = session;
	session.addEventListener('end', teardownVR);
	setStatus('warn', 'Starting VR…');
	showLoading('Starting VR…', 30);

	try {
		const { Viewer } = await (viewerModule ??= import('./viewer.js'));
		if (session !== vrSession) return;

		// Free the desktop viewer's GPU memory while in VR.
		destroyPanoramaViewer();
		els.panorama.hidden = true;
		els.vr.hidden = false;

		vrViewer = new Viewer({ containerId: 'viewer', panorama: currentPanorama, items: allItems(), resolveUrl, config });
		document.body.classList.add('in-vr');
		showLoading('Starting VR…', 70);
		await vrViewer.startSession(session, { mode });
		setStatus('ok', 'In VR');
		hideLoading();
	} catch (error) {
		console.error('Error starting VR:', error);
		setStatus('error', `VR error: ${error.message}`);
		exitVR();
	}
}

function exitVR() {
	const session = vrSession;
	if (!session) {
		teardownVR();
		return;
	}
	clearTimeout(exitFallbackTimer);
	exitFallbackTimer = setTimeout(() => {
		console.warn('XR session did not report "end", forcing teardown');
		teardownVR();
	}, EXIT_TIMEOUT_MS);
	session.end().catch((error) => {
		console.warn('session.end() failed:', error);
		teardownVR();
	});
}

// Single teardown path, driven by the session's "end" event (or the fallback timer).
function teardownVR() {
	if (!vrSession && !vrViewer) return;
	clearTimeout(exitFallbackTimer);
	const viewer = vrViewer;
	vrViewer = null;
	vrSession = null;

	// three.js listens to the same "end" event; let it restore its state before disposing.
	setTimeout(() => {
		try {
			viewer?.destroy();
		} catch (error) {
			console.error('Error destroying VR viewer:', error);
		}
		els.vr.replaceChildren();
		els.vr.hidden = true;
		document.body.classList.remove('in-vr');
		els.panorama.hidden = false;
		if (!panoramaViewer) initPanoramaViewer(currentPanorama);
		hideLoading();
		els.enterVr.disabled = !(xrSupport.vr || xrSupport.ar);
		if (els.status.dataset.state !== 'error') setStatus('ok', 'VR ready');
	}, 0);
}

// --- Startup ------------------------------------------------------------

async function init() {
	document.title = config.title;
	els.title.textContent = config.title;

	els.enterVr.addEventListener('click', enterVR);
	els.openGallery.addEventListener('click', openGalleryModal);
	els.prevPhoto.addEventListener('click', () => stepPhoto(-1));
	els.nextPhoto.addEventListener('click', () => stepPhoto(1));
	window.addEventListener('keydown', onKeyDown);
	els.copyLink.addEventListener('click', copyLink);
	els.toggleHotspots.addEventListener('click', toggleHotspots);
	els.modalClose.addEventListener('click', () => els.modal.close());
	els.modal.addEventListener('click', (event) => {
		if (event.target === els.modal) els.modal.close();
	});
	els.openGlobe.addEventListener('click', openGlobeModal);
	els.globeClose.addEventListener('click', () => els.globeModal.close());
	els.globeModal.addEventListener('click', (event) => {
		if (event.target === els.globeModal) els.globeModal.close();
	});
	els.globeModal.addEventListener('close', closeGlobeView);

	els.vr.addEventListener('exitvrrequest', exitVR);
	els.vr.addEventListener('panoramachange', (event) => {
		currentPanorama = event.detail.path;
		history.replaceState(null, '', `#panorama=${encodeURIComponent(currentPanorama)}`);
		refreshCurrentPhoto();
	});

	window.addEventListener('hashchange', onHashChange);
	window.addEventListener('resize', () => panoramaViewer?.autoSize());

	detectXrSupport();

	setupDragAndDrop();

	[galleryItems] = await Promise.all([loadGallery(), library.open()]);
	const requested = panoramaFromHash();
	currentPanorama = isAvailable(requested) ? requested : resolveDefaultPanorama();
	if (requested && requested !== currentPanorama) {
		history.replaceState(null, '', `#panorama=${encodeURIComponent(currentPanorama)}`);
		showToast('That photo is no longer stored on this device.', 'error');
	}
	initPanoramaViewer(currentPanorama, requested === currentPanorama ? viewFromHash() : {});
	renderGallery();
}

init();
