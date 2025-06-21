import { Viewer as PhotoSphereViewer } from '@photo-sphere-viewer/core';

// Global variables
let panoramaViewer = null;
let vrViewer = null;
let isVRMode = false;
let vrSession = null;
let currentXrReferenceSpace = null;
let nonVrAnimationFrameId = null;

const preferredReferenceSpaces = ['local-floor', 'local', 'viewer'];
const DEFAULT_PANORAMA = 'DEFAULT.JPG';

// Function to get panorama from URL hash
function getPanoramaFromUrl() {
	const hash = window.location.hash.substring(1); // Remove #
	const params = new URLSearchParams(hash);
	return params.get('panorama');
}

// Initialize Photo Sphere Viewer
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
		
		// Try different import methods
		let ViewerClass;
		try {
			const module = await import('./viewer.js');
			ViewerClass = module.Viewer || module.default;
		} catch (importError) {
			console.error('Failed to import viewer.js:', importError);
			throw new Error('Could not load VR viewer module');
		}
		
		if (!ViewerClass) {
			throw new Error('Viewer class not found in imported module');
		}
		
		const panoramaUrl = getPanoramaFromUrl() || DEFAULT_PANORAMA;
		console.log('Creating VR Viewer instance...');
		vrViewer = new ViewerClass({
			containerId: 'viewer', // Changed 'container' to 'containerId'
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
		
		// Hide Photo Sphere Viewer
		document.getElementById('panorama-viewer').style.display = 'none';
		
		// Show VR Viewer container
		document.getElementById('viewer').style.display = 'block';
		
		// Initialize VR viewer if not already done
		if (!vrViewer) {
			await initVRViewer();
			// Wait a bit for the viewer to fully initialize
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		
		isVRMode = true;
		console.log('Switched to VR mode');
		
		// Now enter VR
		await enterVR();
		
	} catch (error) {
		console.error('Error switching to VR mode:', error);
		updateStatus('session-status', `VR Switch Error: ${error.message}`, 'error');
		switchToPanoramaMode(); // Fallback to panorama mode
	}
}

// Switch back to Panorama mode
function switchToPanoramaMode() {
	if (!isVRMode) return;
	
	console.log('Switching to Panorama mode');
	
	// Hide VR Viewer
	document.getElementById('viewer').style.display = 'none';
	
	// Show Photo Sphere Viewer
	document.getElementById('panorama-viewer').style.display = 'block';
	
	// Cleanup VR viewer if it exists
	if (vrViewer && vrViewer.destroy) {
		vrViewer.destroy();
		vrViewer = null;
	}
	
	// Resize panorama viewer to ensure it displays correctly
	if (panoramaViewer) {
		setTimeout(() => {
			panoramaViewer.resize();
		}, 100);
	}
	
	isVRMode = false;
	updateStatus('session-status', 'Returned to panorama view', 'ok');
}

// VR Functions
async function enterVR() {
	if (!vrViewer || !vrViewer.renderer || !vrViewer.renderer.xr) {
		updateStatus('session-status', 'Error: VR Renderer not ready.', 'error');
		console.error("VR Renderer or XR module not initialized.");
		return;
	}

	updateStatus('session-status', 'Attempting to start VR session...', 'warning');
	showVrLoading('Initializing VR Experience...');
	updateProgress(10, 'Checking VR capabilities...');
	console.log('Attempting to enter VR...');

	try {
		if (!navigator.xr) {
			throw new Error('WebXR API not available.');
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
					console.log(`Successfully obtained native reference space: ${type}`, currentXrReferenceSpace);
					break;
				}
			} catch (e) {
				console.warn(`Native reference space type ${type} not supported or failed: ${e.message}`);
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

		// Stop the non-VR animation loop when entering VR
		if (nonVrAnimationFrameId) {
			cancelAnimationFrame(nonVrAnimationFrameId);
			nonVrAnimationFrameId = null;
		}

		// Add keyboard listeners for VR rotation
		window.addEventListener('keydown', vrViewer.onKeyDown.bind(vrViewer));
		window.addEventListener('keyup', vrViewer.onKeyUp.bind(vrViewer));

		updateProgress(80, 'Starting VR rendering loop...');
		vrViewer.renderer.setAnimationLoop((timestamp, frame) => {
			if (!frame) {
				return;
			}
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
		console.log('VR animation loop started.');

		enterVrBtn.disabled = true;
		exitVrBtn.disabled = false;
		updateStatus('session-status', 'VR session active', 'ok');
		updateProgress(100, 'VR Ready!');

		setTimeout(() => {
			hideVrLoading();
		}, 1000);

		session.addEventListener('end', () => {
			console.log('XR session ended event received.');
			onXRSessionEnded();
		});

	} catch (error) {
		console.error('Error entering VR:', error);
		updateStatus('session-status', `VR Error: ${error.message}`, 'error');
		document.getElementById('loading-text').textContent = `VR Initialization Failed: ${error.message}`;
		updateProgress(0, '');

		setTimeout(() => {
			hideVrLoading();
			switchToPanoramaMode(); // Return to panorama mode on error
		}, 4000);

		if (vrSession) {
			try {
				if (vrSession.ended === false) {
					await vrSession.end();
				}
			} catch (endError) {
				console.warn('Error trying to end partially started session during error handling:', endError);
			}
		}
		onXRSessionEnded();
	}
}

function onXRSessionEnded() {
	console.log('Cleaning up after XR session ended.');
	if (vrViewer && vrViewer.renderer && vrViewer.renderer.xr) {
		vrViewer.renderer.xr.enabled = false;
		if (vrViewer.renderer.setAnimationLoop) {
			vrViewer.renderer.setAnimationLoop(null);
		}
	}

	enterVrBtn.disabled = false;
	exitVrBtn.disabled = true;
	updateStatus('session-status', 'No active VR session');
	setReferenceSpaceInfo('Not set');

	vrSession = null;
	currentXrReferenceSpace = null;

	// Remove keyboard listeners when exiting VR
	if (vrViewer) {
		window.removeEventListener('keydown', vrViewer.onKeyDown);
		window.removeEventListener('keyup', vrViewer.onKeyUp);
		vrViewer.isRotatingLeft = false;
		vrViewer.isRotatingRight = false;
	}

	hideVrLoading();
	
	// Switch back to panorama mode
	switchToPanoramaMode();
	
	console.log('Cleaned up XR session resources.');
}

async function exitVR() {
	console.log('Attempting to exit VR...');
	showVrLoading('Exiting VR...');
	if (vrSession) {
		try {
			if (vrSession.ended === false) {
				await vrSession.end();
				console.log('VR session.end() called.');
			} else {
				console.log('VR session was already ended.');
				onXRSessionEnded();
			}
		} catch (e) {
			console.error('Error ending VR session:', e);
			onXRSessionEnded();
		}
	} else {
		console.log('No active VR session to exit.');
		onXRSessionEnded();
	}
}

// Helper functions
function updateStatus(elementId, message, type = '') {
	const element = document.getElementById(elementId);
	const indicator = document.getElementById(elementId + '-indicator');
	
	if (element) {
		element.textContent = message;
	}
	
	if (indicator) {
		indicator.className = `status-indicator status-${type}`;
	}
}

function setReferenceSpaceInfo(info) {
	const element = document.getElementById('reference-space');
	if (element) {
		element.textContent = `Reference Space: ${info}`;
	}
}

function updateProgress(percent, text) {
	const progressBar = document.getElementById('progress-bar');
	const loadingText = document.getElementById('loading-text');
	
	if (progressBar) {
		progressBar.style.width = percent + '%';
	}
	
	if (loadingText && text) {
		loadingText.textContent = text;
	}
}

function showVrLoading(text) {
	const loading = document.getElementById('vr-loading');
	const loadingText = document.getElementById('loading-text');
	
	if (loadingText && text) {
		loadingText.textContent = text;
	}
	
	if (loading) {
		loading.classList.add('visible');
	}
}

function hideVrLoading() {
	const loading = document.getElementById('vr-loading');
	if (loading) {
		loading.classList.remove('visible');
	}
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
let initialPanoramaUrl = ''; // Store the initial URL to check for changes

// Gallery elements - DECLARE THEM HERE
const openGalleryBtn = document.getElementById('open-gallery-btn');
const galleryModal = document.getElementById('gallery-modal');
const galleryCloseButton = document.getElementById('gallery-close-button');
const galleryItemsContainer = document.getElementById('gallery-items-container');
let galleryData = [];

// Function to load gallery data
async function loadGalleryData() {
	try {
		const response = await fetch('gallery.json');
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		galleryData = await response.json();
		return galleryData;
	} catch (error) {
		console.error("Could not load gallery data:", error);
		if (galleryItemsContainer) {
			galleryItemsContainer.innerHTML = '<p style="color: #ff416c;">Error loading gallery. Please check console.</p>';
		}
		return []; // Return empty array on error
	}
}

// Function to create a single gallery item element
function createGalleryItemElement(item) {
	const itemDiv = document.createElement('div');
	itemDiv.classList.add('gallery-item');
	itemDiv.dataset.path = item.path;

	const img = document.createElement('img');
	img.src = item.thumbnail || 'placeholder_thumbnail.png'; // Use a placeholder if no thumbnail
	img.alt = item.name;
	img.onerror = () => { // Fallback if thumbnail fails to load
		img.src = 'placeholder_thumbnail.png'; // Path to a generic placeholder
		img.style.objectFit = 'contain'; // Adjust fit for placeholder
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
	galleryItemsContainer.innerHTML = ''; // Clear previous items
	if (items.length === 0 && galleryItemsContainer.textContent.includes('Error loading gallery')) {
		// Do not clear error message if items are empty due to load failure
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
	if (galleryData.length === 0) { // If gallery data hasn't been loaded or failed
		loadGalleryData().then(data => {
			populateGallery(data);
			galleryModal.style.display = 'block';
		});
	} else {
		populateGallery(galleryData); // Repopulate in case it was loaded but modal closed
		galleryModal.style.display = 'block';
	}
}

function closeGalleryModal() {
	if (galleryModal) {
		galleryModal.style.display = 'none';
	}
}

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
	initialPanoramaUrl = getPanoramaFromUrl();
	// Initialize Photo Sphere Viewer by default
	initPanoramaViewer();
	
	// Setup event listeners
	if (enterVrBtn) enterVrBtn.addEventListener('click', switchToVRMode);
	if (exitVrBtn) exitVrBtn.addEventListener('click', exitVR);

	// Gallery event listeners
	if (openGalleryBtn) {
		openGalleryBtn.addEventListener('click', openGalleryModal);
	}
	if (galleryCloseButton) {
		galleryCloseButton.addEventListener('click', closeGalleryModal);
	}
	// Close modal if user clicks outside of it
	window.addEventListener('click', (event) => {
		if (galleryModal && event.target === galleryModal) {
			closeGalleryModal();
		}
	});
	
	// Check WebXR status
	updateXrStatus();
	
	// Handle window resize
	window.addEventListener('resize', () => {
		if (panoramaViewer && !isVRMode) {
			panoramaViewer.resize();
		}
	});

	// Listen for hash changes to reload viewer if panorama changes
	window.addEventListener('hashchange', () => {
		const newPanoramaUrl = getPanoramaFromUrl();
		if (newPanoramaUrl && newPanoramaUrl !== (initialPanoramaUrl || DEFAULT_PANORAMA)) {
			console.log('Panorama URL changed in hash, reloading viewer...');
			initialPanoramaUrl = newPanoramaUrl; // Update the stored URL

			// Clean up existing viewers
			if (isVRMode) {
				exitVR().then(() => { // Ensure VR is exited before re-initializing
					if (panoramaViewer && panoramaViewer.destroy) {
						panoramaViewer.destroy();
						panoramaViewer = null;
					}
					initPanoramaViewer(); // Re-initialize with new panorama
				});
			} else {
				if (panoramaViewer && panoramaViewer.destroy) {
					panoramaViewer.destroy();
					panoramaViewer = null;
				}
				if (vrViewer && vrViewer.destroy) { // Also destroy VR viewer if it was initialized
					vrViewer.destroy();
					vrViewer = null;
				}
				initPanoramaViewer(); // Re-initialize with new panorama
			}
		} else if (!newPanoramaUrl && initialPanoramaUrl) {
			// Hash was removed or panorama param removed, reload with default
			console.log('Panorama URL removed from hash, reloading with default...');
			initialPanoramaUrl = ''; // Reset stored URL

			if (isVRMode) {
				exitVR().then(() => {
					if (panoramaViewer && panoramaViewer.destroy) {
						panoramaViewer.destroy();
						panoramaViewer = null;
					}
					initPanoramaViewer();
				});
			} else {
				if (panoramaViewer && panoramaViewer.destroy) {
					panoramaViewer.destroy();
					panoramaViewer = null;
				}
				if (vrViewer && vrViewer.destroy) {
					vrViewer.destroy();
					vrViewer = null;
				}
				initPanoramaViewer();
			}
		}
	});

	const vrViewerContainer = document.getElementById('viewer-container'); // Assuming 'viewer-container' is used for VR
	if (vrViewerContainer) {
		vrViewerContainer.addEventListener('exitvrrequest', () => {
			console.log("App: Received exitvrrequest event.");
			if (isVRMode && vrSession) {
				exitVR();
			}
		});
	}
});
function render() {
	if (isVRMode && vrSession) {
		vrSession.requestAnimationFrame(onAnimationFrame);
	} else {
		nonVrAnimationFrameId = requestAnimationFrame(render);
	}
}