import { Viewer as PhotoSphereViewer } from '@photo-sphere-viewer/core';

// Global variables
let panoramaViewer = null;
let vrViewer = null;
let isVRMode = false;
let vrSession = null;
let currentXrReferenceSpace = null;

const preferredReferenceSpaces = ['local-floor', 'local', 'viewer'];
const DEFAULT_PANORAMA = 'DEFAULT.JPG';

// Function to get panorama from URL hash
function getPanoramaFromUrl() {
	const hash = window.location.hash.substring(1);
	const params = new URLSearchParams(hash);
	return params.get('panorama');
}

// Initialize Photo Sphere Viewer for non-VR display
function initPanoramaViewer() {
	try {
		const panoramaUrl = getPanoramaFromUrl() || DEFAULT_PANORAMA;
		panoramaViewer = new PhotoSphereViewer({
			container: 'panorama-viewer',
			panorama: panoramaUrl,
			navbar: [
				'zoom',
				'move',
				'fullscreen',
			],
			defaultZoomLvl: 0,
			minFov: 30,
			maxFov: 90,
			mousewheel: true,
			mousemove: true,
			keyboard: 'fullscreen',
			moveSpeed: 1.0,
			zoomSpeed: 1.0,
		});

		console.log('Photo Sphere Viewer initialized successfully');

		panoramaViewer.addEventListener('ready', () => {
			console.log('Panorama viewer is ready');
			updateStatus('renderer-status', 'Photo Sphere Viewer ready', 'ok');
		});

		panoramaViewer.addEventListener('error', (err) => {
			console.error('Panorama viewer error:', err);
			updateStatus('renderer-status', `Error: ${err.message}`, 'error');
		});

	} catch (error) {
		console.error('Failed to initialize Photo Sphere Viewer:', error);
		updateStatus('renderer-status', `Init Error: ${error.message}`, 'error');
	}
}

// Initialize VR Viewer (only when entering VR)
async function initVRViewer() {
	try {
		console.log('Importing VR Viewer module...');

		let ViewerClass;
		try {
			const module = await import('./viewer.js');
			ViewerClass = module.Viewer || module.default;
		} catch (importError) {
			console.error('Failed to import viewer.js:', importError);
			throw new Error('Could not load VR viewer module. Ensure viewer.js exists and is accessible.');
		}

		if (!ViewerClass) {
			throw new Error('Viewer class not found in imported module. Check viewer.js export.');
		}

		const panoramaUrl = getPanoramaFromUrl() || DEFAULT_PANORAMA;
		console.log('Creating VR Viewer instance...');
		vrViewer = new ViewerClass({
			containerId: 'viewer',
			panorama: panoramaUrl,
			caption: '360° VR Panorama Viewer'
		});

		console.log('VR Viewer initialized successfully');
		return vrViewer;
	} catch (error) {
		console.error('Failed to initialize VR Viewer:', error);
		throw error;
	}
}

// Switch to VR mode
async function switchToVRMode() {
	if (isVRMode) return;

	try {
		updateStatus('session-status', 'Switching to VR mode...', 'warning');

		if (panoramaViewer) {
			console.log('Destroying Photo Sphere Viewer before entering VR');
			panoramaViewer.destroy();
			panoramaViewer = null;
		}

		document.getElementById('panorama-viewer').style.display = 'none';
		document.getElementById('viewer').style.display = 'block';

		if (!vrViewer) {
			await initVRViewer();
			await new Promise(resolve => setTimeout(resolve, 500));
		}

		isVRMode = true;
		console.log('Switched to VR mode flag set');
		await enterVR();

	} catch (error) {
		console.error('Error switching to VR mode:', error);
		updateStatus('session-status', `VR Switch Error: ${error.message}`, 'error');
		switchToPanoramaMode();
	}
}

// Switch back to Panorama mode
function switchToPanoramaMode() {
	console.log('Switching to Panorama mode');

	document.getElementById('viewer').style.display = 'none';

	if (vrViewer) {
		console.log("Destroying VR viewer instance");
		vrViewer.destroy();
		vrViewer = null;
	}

	const viewerContainer = document.getElementById('viewer');
	while (viewerContainer.firstChild) {
		viewerContainer.removeChild(viewerContainer.firstChild);
	}

	if (!panoramaViewer) {
		console.log('Initializing Photo Sphere Viewer for non-VR display');
		initPanoramaViewer();
	}

	const panoramaContainer = document.getElementById('panorama-viewer');
	panoramaContainer.style.display = 'block';

	if (panoramaViewer) {
		setTimeout(() => {
			console.log('Resizing Photo Sphere Viewer');
			panoramaViewer.resize();
		}, 100);
	}

	isVRMode = false;
	updateStatus('session-status', 'Returned to panorama view', 'ok');
}

// VR Functions
async function enterVR() {
	console.log('Attempting to enter VR...');
	if (!vrViewer || !vrViewer.renderer || !vrViewer.renderer.xr) {
		updateStatus('session-status', 'Error: VR Renderer not ready for session.', 'error');
		console.error("VR Viewer, Renderer, or XR module not initialized for session.");
		return;
	}

	updateStatus('session-status', 'Attempting to start VR session...', 'warning');
	showVrLoading('Initializing VR Experience...');
	updateProgress(10, 'Checking VR capabilities...');

	try {
		if (!navigator.xr) {
			throw new Error('WebXR API not available in this browser.');
		}

		updateProgress(20, 'Verifying session support...');
		const immersiveSupported = await navigator.xr.isSessionSupported('immersive-vr');
		if (!immersiveSupported) {
			throw new Error('Immersive VR session not supported on this device.');
		}
		console.log('Immersive VR supported.');

		updateProgress(30, 'Requesting VR session...');
		const session = await navigator.xr.requestSession('immersive-vr');
		vrSession = session;
		console.log('XR session obtained:', session);

		session.addEventListener('end', onXRSessionEnded);
		console.log('Attached "end" event listener to XR session.');

		vrViewer.renderer.xr.enabled = true;
		console.log('Three.js XR manager enabled.');

		updateProgress(40, 'Finding supported reference space...');
		let selectedSpaceType = null;
		currentXrReferenceSpace = null;

		for (const type of preferredReferenceSpaces) {
			try {
				console.log(`Attempting to request native reference space: ${type}`);
				const refSpace = await session.requestReferenceSpace(type);
				if (refSpace) {
					currentXrReferenceSpace = refSpace;
					selectedSpaceType = type;
					console.log(`Successfully obtained native reference space: ${type}`);
					break;
				}
			} catch (e) {
				console.warn(`Native reference space type ${type} not supported: ${e.message}`);
			}
		}

		if (!selectedSpaceType) {
			throw new Error('Could not obtain any supported XR reference space natively.');
		}
		vrViewer.setReferenceSpaceInfo(selectedSpaceType);
		updateProgress(50, `Using reference space: ${selectedSpaceType}`);

		vrViewer.renderer.xr.setReferenceSpaceType(selectedSpaceType);
		console.log(`Three.js WebXRManager referenceSpaceType set to: ${selectedSpaceType}`);

		updateProgress(60, 'Initializing Three.js XR session...');
		await vrViewer.renderer.xr.setSession(session);
		console.log('Three.js XR session has been set.');

		window.addEventListener('keydown', vrViewer.onKeyDown.bind(vrViewer));
		window.addEventListener('keyup', vrViewer.onKeyUp.bind(vrViewer));

		updateProgress(80, 'Starting VR rendering loop...');
		vrViewer.renderer.setAnimationLoop((timestamp, frame) => {
			if (!frame) return;
			
			if (vrViewer.isRotatingLeft) {
				vrViewer.sphere.rotation.y += vrViewer.vrRotationSpeed;
			}
			if (vrViewer.isRotatingRight) {
				vrViewer.sphere.rotation.y -= vrViewer.vrRotationSpeed;
			}

			const rotation = vrViewer.camera.rotation;
			vrViewer.updateCameraOrientation(rotation.x, rotation.y, rotation.z);
			vrViewer.render();
		});
		console.log('VR animation loop started with Three.js XR manager.');

		enterVrBtn.disabled = true;
		exitVrBtn.disabled = false;
		updateStatus('session-status', 'VR session active', 'ok');
		updateProgress(100, 'VR Ready!');

		setTimeout(() => {
			hideVrLoading();
		}, 1000);

	} catch (error) {
		console.error('Error entering VR:', error);
		updateStatus('session-status', `VR Error: ${error.message}`, 'error');
		document.getElementById('loading-text').textContent = `VR Initialization Failed: ${error.message}`;
		updateProgress(0, '');

		setTimeout(() => {
			hideVrLoading();
			switchToPanoramaMode();
		}, 4000);

		if (vrSession && !vrSession.ended) {
			try {
				console.log('Attempting to end session during error handling');
				await vrSession.end();
			} catch (endError) {
				console.warn('Error ending session during error handling:', endError);
			}
		}
		onXRSessionEnded();
	}
}

// Function called when the XR session ends
function onXRSessionEnded() {
	console.log('onXRSessionEnded called');
	
	if (vrViewer && vrViewer.renderer && vrViewer.renderer.xr) {
		console.log('Stopping Three.js animation loop');
		vrViewer.renderer.setAnimationLoop(null);
		vrViewer.renderer.xr.enabled = false;
	}

	enterVrBtn.disabled = false;
	exitVrBtn.disabled = true;
	updateStatus('session-status', 'No active VR session');
	setReferenceSpaceInfo('Not set');

	if (vrViewer) {
		console.log('Removing keyboard listeners');
		window.removeEventListener('keydown', vrViewer.onKeyDown);
		window.removeEventListener('keyup', vrViewer.onKeyUp);
		vrViewer.isRotatingLeft = false;
		vrViewer.isRotatingRight = false;
	}

	hideVrLoading();

	vrSession = null;
	currentXrReferenceSpace = null;
	
	console.log('Calling switchToPanoramaMode from onXRSessionEnded');
	switchToPanoramaMode();
}

// Function to explicitly exit VR
async function exitVR() {
	console.log('exitVR called');
	showVrLoading('Exiting VR...');
	
	enterVrBtn.disabled = true;
	exitVrBtn.disabled = true;

	if (vrSession && !vrSession.ended) {
		try {
			console.log('Ending VR session');
			await vrSession.end();
			console.log('VR session ended successfully');
		} catch (e) {
			console.error('Error ending VR session:', e);
		}
	} else {
		console.log('No active VR session to end');
	}

	console.log('Calling onXRSessionEnded from exitVR');
	onXRSessionEnded();
}

// Helper functions for UI status updates
function updateStatus(elementId, message, type = '') {
	const element = document.getElementById(elementId);
	const indicator = document.getElementById(elementId + '-indicator');
	if (element) element.textContent = message;
	if (indicator) indicator.className = `status-indicator status-${type}`;
}

function setReferenceSpaceInfo(info) {
	const element = document.getElementById('reference-space');
	if (element) element.textContent = `Reference Space: ${info}`;
}

function updateProgress(percent, text) {
	const progressBar = document.getElementById('progress-bar');
	const loadingText = document.getElementById('loading-text');
	if (progressBar) progressBar.style.width = percent + '%';
	if (loadingText && text) loadingText.textContent = text;
}

function showVrLoading(text) {
	const loading = document.getElementById('vr-loading');
	const loadingText = document.getElementById('loading-text');
	if (loadingText && text) loadingText.textContent = text;
	if (loading) loading.classList.add('visible');
}

function hideVrLoading() {
	const loading = document.getElementById('vr-loading');
	if (loading) loading.classList.remove('visible');
}

function updateXrStatus() {
	const statusElem = document.getElementById('xr-status');
	const indicator = document.getElementById('xr-status-indicator');
	if (!navigator.xr) {
		statusElem.textContent = 'WebXR API not available in this browser.';
		indicator.className = 'status-indicator status-error';
		enterVrBtn.disabled = true;
		return;
	}
	indicator.className = 'status-indicator status-warning';
	statusElem.textContent = 'Checking WebXR immersive-vr support...';
	setTimeout(() => {
		navigator.xr.isSessionSupported('immersive-vr')
			.then((supported) => {
				if (supported) {
					statusElem.textContent = 'WebXR supported - Ready for VR';
					indicator.className = 'status-indicator status-ok';
					enterVrBtn.disabled = false;
				} else {
					statusElem.textContent = 'WebXR immersive-vr not supported on this device.';
					indicator.className = 'status-indicator status-error';
					enterVrBtn.disabled = true;
				}
			})
			.catch((error) => {
				console.error('WebXR support check failed:', error);
				statusElem.textContent = `WebXR check failed: ${error.message}`;
				indicator.className = 'status-indicator status-error';
				enterVrBtn.disabled = true;
			});
	}, 500);
}

// DOM elements and event listeners
const enterVrBtn = document.getElementById('enter-vr');
const exitVrBtn = document.getElementById('exit-vr');
let initialPanoramaUrl = '';

// Gallery elements
const openGalleryBtn = document.getElementById('open-gallery-btn');
const galleryModal = document.getElementById('gallery-modal');
const galleryCloseButton = document.getElementById('gallery-close-button');
const galleryItemsContainer = document.getElementById('gallery-items-container');
let galleryData = [];

// Function to load gallery data
async function loadGalleryData() {
	try {
		const response = await fetch('gallery.json');
		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
		galleryData = await response.json();
		return galleryData;
	} catch (error) {
		console.error("Could not load gallery data:", error);
		if (galleryItemsContainer) {
			galleryItemsContainer.innerHTML = '<p style="color: #ff416c;">Error loading gallery. Please check console.</p>';
		}
		return [];
	}
}

// Function to create a single gallery item element
function createGalleryItemElement(item) {
	const itemDiv = document.createElement('div');
	itemDiv.classList.add('gallery-item');
	itemDiv.dataset.path = item.path;

	const img = document.createElement('img');
	img.src = item.thumbnail || 'https://placehold.co/150x100/CCCCCC/000000?text=No+Thumbnail';
	img.alt = item.name;
	img.onerror = () => {
		img.src = 'https://placehold.co/150x100/CCCCCC/000000?text=No+Thumbnail';
		img.style.objectFit = 'contain';
	};

	const nameH3 = document.createElement('h3');
	nameH3.textContent = item.name;

	const descP = document.createElement('p');
	descP.textContent = item.description;

	itemDiv.appendChild(img);
	itemDiv.appendChild(nameH3);
	itemDiv.appendChild(descP);

	itemDiv.addEventListener('click', () => {
		window.location.hash = `panorama=${item.path}`;
		closeGalleryModal();
	});

	return itemDiv;
}

// Function to populate gallery
function populateGallery(items) {
	if (!galleryItemsContainer) return;
	galleryItemsContainer.innerHTML = '';
	if (items.length === 0 && galleryItemsContainer.textContent.includes('Error loading gallery')) {
		return;
	} else if (items.length === 0) {
		galleryItemsContainer.innerHTML = '<p>No images found in the gallery.</p>';
	} else {
		items.forEach(item => {
			galleryItemsContainer.appendChild(createGalleryItemElement(item));
		});
	}
}

// Functions to open and close gallery modal
function openGalleryModal() {
	if (!galleryModal) return;
	if (galleryData.length === 0) {
		loadGalleryData().then(data => {
			populateGallery(data);
			galleryModal.style.display = 'block';
		});
	} else {
		populateGallery(galleryData);
		galleryModal.style.display = 'block';
	}
}

function closeGalleryModal() {
	if (galleryModal) galleryModal.style.display = 'none';
}

// Initialize the app when DOM content is loaded
document.addEventListener('DOMContentLoaded', () => {
	initialPanoramaUrl = getPanoramaFromUrl();
	initPanoramaViewer();

	if (enterVrBtn) enterVrBtn.addEventListener('click', switchToVRMode);
	if (exitVrBtn) exitVrBtn.addEventListener('click', exitVR);

	if (openGalleryBtn) openGalleryBtn.addEventListener('click', openGalleryModal);
	if (galleryCloseButton) galleryCloseButton.addEventListener('click', closeGalleryModal);
	
	window.addEventListener('click', (event) => {
		if (galleryModal && event.target === galleryModal) closeGalleryModal();
	});

	updateXrStatus();

	window.addEventListener('resize', () => {
		if (panoramaViewer && !isVRMode) panoramaViewer.resize();
	});

	window.addEventListener('hashchange', () => {
		const newPanoramaUrl = getPanoramaFromUrl();
		if (newPanoramaUrl && newPanoramaUrl !== initialPanoramaUrl) {
			console.log(`Panorama changed to: ${newPanoramaUrl}. Re-initializing panorama viewer.`);
			if (panoramaViewer) {
				panoramaViewer.destroy();
				panoramaViewer = null;
			}
			initPanoramaViewer();
			initialPanoramaUrl = newPanoramaUrl;
		}
	});

	const vrViewerElement = document.getElementById('viewer');
	if (vrViewerElement) {
		vrViewerElement.addEventListener('exitvrrequest', (e) => {
			console.log("app.js: 'exitvrrequest' event received from VR viewer");
			try {
				exitVR();
			} catch (error) {
				console.error("Error handling exitvrrequest:", error);
				switchToPanoramaMode();
			}
		});
	}
});