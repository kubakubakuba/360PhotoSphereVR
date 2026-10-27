import { Viewer as PhotoSphereViewer } from '@photo-sphere-viewer/core';
import { LocalLibrary } from './local-library.js';
import { itemCoordinates } from './vr/geo.js';

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
};
const config = { ...DEFAULT_CONFIG, ...(window.APP_CONFIG || {}) };
const FALLBACK_PANORAMA = 'DEFAULT.JPG';
const PLACEHOLDER_THUMBNAIL = 'placeholder_thumbnail.png';
const EXIT_TIMEOUT_MS = 2000;
const PANORAMA_ERROR = 'Could not load panorama';

let panoramaViewer = null;
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
};

const ICONS = {
	add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
	remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

// --- Helpers ------------------------------------------------------------

function panoramaFromHash() {
	return new URLSearchParams(window.location.hash.slice(1)).get('panorama');
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

function initPanoramaViewer(path) {
	const compact = window.innerWidth < 600;
	panoramaViewer = new PhotoSphereViewer({
		container: els.panorama,
		panorama: resolveUrl(path),
		navbar: compact ? ['zoom', 'fullscreen'] : ['zoom', 'move', 'fullscreen'],
		defaultZoomLvl: 0,
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
	});
}

function showPanorama(path) {
	if (!path || path === currentPanorama) return;
	if (!isAvailable(path)) {
		showToast('That photo is no longer stored on this device.', 'error');
		history.replaceState(null, '', `#panorama=${encodeURIComponent(currentPanorama)}`);
		return;
	}
	currentPanorama = path;
	refreshCurrentPhoto();
	if (panoramaViewer) {
		panoramaViewer.setPanorama(resolveUrl(path), { transition: 800, showLoader: true }).catch((error) => {
			console.error('setPanorama failed:', error);
		});
	}
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

	if (item.local) {
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'card-remove';
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
	globeView?.setItems(allItems(), currentPanorama);
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

function onArrowKey(event) {
	if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
	if (vrSession || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
	// In fullscreen the arrow keys rotate the view (Photo Sphere Viewer keyboard control).
	if (els.modal.open || els.globeModal.open || document.fullscreenElement) return;
	if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
	event.preventDefault();
	stepPhoto(event.key === 'ArrowRight' ? 1 : -1);
}

function openGalleryModal() {
	els.modal.showModal();
	els.modal.querySelector('.gallery-card[aria-current]')?.scrollIntoView({ block: 'nearest' });
}

// --- Map ----------------------------------------------------------------

function globeAvailable() {
	return config.globe !== false && allItems().some((item) => itemCoordinates(item));
}

async function openGlobeModal() {
	if (els.modal.open) els.modal.close();
	els.globeModal.showModal();
	try {
		const { GlobeView } = await (globeModule ??= import('./globe-view.js'));
		if (!els.globeModal.open || globeView) return;
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
			zoom: { in: els.globeZoomIn, out: els.globeZoomOut },
			items: allItems(),
			current: currentPanorama,
			config,
			resolveUrl,
			onOpen: (path) => {
				window.location.hash = `panorama=${encodeURIComponent(path)}`;
				els.globeModal.close();
			},
		});
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
		panoramaViewer?.destroy();
		panoramaViewer = null;
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
	window.addEventListener('keydown', onArrowKey);
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

	window.addEventListener('hashchange', () => showPanorama(panoramaFromHash()));
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
	initPanoramaViewer(currentPanorama);
	renderGallery();
}

init();
