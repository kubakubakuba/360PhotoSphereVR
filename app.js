import { Viewer as PhotoSphereViewer } from '@photo-sphere-viewer/core';

// Global variables
let panoramaViewer = null;
let vrViewer = null;
let isVRMode = false;
let vrSession = null;
let currentXrReferenceSpace = null;
// Removed nonVrAnimationFrameId as a general render loop isn't needed here;
// PhotoSphereViewer and Three.js XR manager handle their own loops.

const preferredReferenceSpaces = ['local-floor', 'local', 'viewer'];
const DEFAULT_PANORAMA = 'DEFAULT.JPG';

// Function to get panorama from URL hash
function getPanoramaFromUrl() {
	const hash = window.location.hash.substring(1); // Remove #
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
			// Attempt to import the VR Viewer module (assuming viewer.js is in the same directory)
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
	if (isVRMode) return; // Already in VR mode

	try {
		updateStatus('session-status', 'Switching to VR mode...', 'warning');

		// Step 1: Destroy the current Photo Sphere Viewer instance
		if (panoramaViewer) {
			panoramaViewer.destroy(); // Properly release resources
			panoramaViewer = null; // Clear the reference
			console.log('Photo Sphere Viewer destroyed before entering VR.');
		}

		// Hide Photo Sphere Viewer container and show VR Viewer container
		document.getElementById('panorama-viewer').style.display = 'none';
		document.getElementById('viewer').style.display = 'block';

		// Initialize VR viewer if not already done
		if (!vrViewer) {
			await initVRViewer();
			// Give a moment for the VR viewer to be ready for the session
			await new Promise(resolve => setTimeout(resolve, 500));
		}

		isVRMode = true;
		console.log('Switched to VR mode flag set.');

		// Now, proceed to enter the WebXR immersive session
		await enterVR();

	} catch (error) {
		console.error('Error switching to VR mode:', error);
		updateStatus('session-status', `VR Switch Error: ${error.message}`, 'error');
		// Fallback to panorama mode if VR entry fails
		switchToPanoramaMode();
	}
}

// Switch back to Panorama mode
function switchToPanoramaMode() {
	console.log('Switching to Panorama mode');

	// Hide VR Viewer container
	document.getElementById('viewer').style.display = 'none';

	// Step 2: Cleanup VR viewer if it exists and release its animation loop
	if (vrViewer) {
		if (vrViewer.destroy) { // Assuming vrViewer has a destroy method
			console.log("Destroying VR viewer instance.");
			vrViewer.destroy();
		}
		vrViewer = null;
	}

	// Step 3: Re-initialize Photo Sphere Viewer if it was destroyed
	if (!panoramaViewer) {
		initPanoramaViewer();
		console.log('Photo Sphere Viewer re-initialized for non-VR display.');
	}

	// Show Photo Sphere Viewer container
	document.getElementById('panorama-viewer').style.display = 'block';

	// Ensure panoramaViewer resizes and re-renders after being shown
	// A small delay can help ensure the display property has taken effect
	if (panoramaViewer) {
		setTimeout(() => {
			panoramaViewer.resize();
			console.log('Photo Sphere Viewer resized after re-showing.');
		}, 100);
	}

	isVRMode = false;
	updateStatus('session-status', 'Returned to panorama view', 'ok');
}

// VR Functions
async function enterVR() {
	if (!vrViewer || !vrViewer.renderer || !vrViewer.renderer.xr) {
		updateStatus('session-status', 'Error: VR Renderer not ready for session.', 'error');
		console.error("VR Viewer, Renderer, or XR module not initialized for session.");
		return;
	}

	updateStatus('session-status', 'Attempting to start VR session...', 'warning');
	showVrLoading('Initializing VR Experience...');
	updateProgress(10, 'Checking VR capabilities...');
	console.log('Attempting to enter VR...');

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

		// Crucial: Attach the 'end' event listener to the session
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

		// Set the reference space type for the Three.js XR manager
		vrViewer.renderer.xr.setReferenceSpaceType(selectedSpaceType);
		console.log(`Three.js WebXRManager referenceSpaceType set to: ${selectedSpaceType}`);

		updateProgress(60, 'Initializing Three.js XR session...');
		// Set the XR session with the Three.js XR manager
		await vrViewer.renderer.xr.setSession(session);
		console.log('Three.js XR session has been set.');

		// Add keyboard listeners for VR rotation
		window.addEventListener('keydown', vrViewer.onKeyDown.bind(vrViewer));
		window.addEventListener('keyup', vrViewer.onKeyUp.bind(vrViewer));

		updateProgress(80, 'Starting VR rendering loop...');
		// Start the Three.js XR animation loop
		vrViewer.renderer.setAnimationLoop((timestamp, frame) => {
			if (!frame) {
				return; // No frame available yet
			}
			// Apply keyboard rotation if active
			if (vrViewer.isRotatingLeft) {
				vrViewer.sphere.rotation.y += vrViewer.vrRotationSpeed;
			}
			if (vrViewer.isRotatingRight) {
				vrViewer.sphere.rotation.y -= vrViewer.vrRotationSpeed;
			}

			// Update camera orientation and render the scene
			const rotation = vrViewer.camera.rotation;
			vrViewer.updateCameraOrientation(rotation.x, rotation.y, rotation.z);
			vrViewer.render();
		});
		console.log('VR animation loop started with Three.js XR manager.');

		enterVrBtn.disabled = true;
		exitVrBtn.disabled = false;
		updateStatus('session-status', 'VR session active', 'ok');
		updateProgress(100, 'VR Ready!');

		// Hide loading screen after a short delay
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
			switchToPanoramaMode(); // Return to panorama mode on error
		}, 4000);

		// Ensure session is ended if it was partially started during an error
		if (vrSession) {
			try {
				if (vrSession.ended === false) {
					await vrSession.end();
				}
			} catch (endError) {
				console.warn('Error trying to end partially started session during error handling:', endError);
			}
		}
		// Always call onXRSessionEnded to ensure cleanup if an error occurs before session.end()
		onXRSessionEnded();
	}
}

// Function called when the XR session ends (either by app or UA)
function onXRSessionEnded() {
	console.log('Cleaning up after XR session ended.');
	// Disable Three.js XR manager and stop its animation loop
	if (vrViewer && vrViewer.renderer && vrViewer.renderer.xr) {
		vrViewer.renderer.xr.enabled = false;
		// Set the animation loop to null to stop Three.js rendering
		if (vrViewer.renderer.setAnimationLoop) {
			vrViewer.renderer.setAnimationLoop(null);
			console.log('Three.js XR animation loop stopped.');
		}
	}

	enterVrBtn.disabled = false;
	exitVrBtn.disabled = true;
	updateStatus('session-status', 'No active VR session');
	setReferenceSpaceInfo('Not set');

	// Clear global references to XR session and reference space
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

	// Switch back to panorama mode, which will re-initialize Photo Sphere Viewer.
	// Added a small delay here to give the browser more time to release XR resources fully.
	setTimeout(() => {
		switchToPanoramaMode();
		console.log('Called switchToPanoramaMode after a short delay.');
	}, 200); // 200ms delay
	
	console.log('Cleaned up XR session resources.');
}

// Function to explicitly exit VR
async function exitVR() {
	console.log('Attempting to exit VR...');
	showVrLoading('Exiting VR...');
	
	// Disable buttons immediately to prevent multiple calls during transition
	enterVrBtn.disabled = true;
	exitVrBtn.disabled = true;

	if (vrSession) {
		try {
			if (vrSession.ended === false) {
				console.log('Calling vrSession.end()...');
				await vrSession.end(); // Explicitly end the WebXR session
				console.log('VR session.end() resolved.');
			} else {
				console.log('VR session was already ended, proceeding with cleanup.');
				// If session was already ended, directly call onXRSessionEnded to ensure cleanup
				onXRSessionEnded();
			}
		} catch (e) {
			console.error('Error ending VR session:', e);
			// Even if there's an error ending, we must proceed with cleanup
			onXRSessionEnded();
		}
	} else {
		console.log('No active VR session to exit, performing cleanup.');
		// If no session was active, just perform cleanup
		onXRSessionEnded();
	}
}

// Helper functions for UI status updates
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
	img.src = item.thumbnail || 'https://placehold.co/150x100/CCCCCC/000000?text=No+Thumbnail'; // Use a placeholder if no thumbnail
	img.alt = item.name;
	img.onerror = () => { // Fallback if thumbnail fails to load
		img.src = 'https://placehold.co/150x100/CCCCCC/000000?text=No+Thumbnail'; // Path to a generic placeholder
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

// Initialize the app when DOM content is loaded
document.addEventListener('DOMContentLoaded', () => {
	initialPanoramaUrl = getPanoramaFromUrl();
	// Initialize Photo Sphere Viewer by default
	initPanoramaViewer();

	// Setup event listeners for VR buttons
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

	// Check WebXR status (e.g., if immersive-vr is supported)
	updateXrStatus();

	// Handle window resize for panorama viewer (only when in non-VR mode)
	window.addEventListener('resize', () => {
		if (panoramaViewer && !isVRMode) {
			panoramaViewer.resize();
		}
	});

	// Listen for hash changes to reload viewer if panorama changes
	window.addEventListener('hashchange', () => {
		const newPanoramaUrl = getPanoramaFromUrl();
		// If the panorama URL in the hash changes and it's different from the current one
		if (newPanoramaUrl && newPanoramaUrl !== initialPanoramaUrl) {
			console.log(`Panorama changed to: ${newPanoramaUrl}. Re-initializing panorama viewer.`);
			// If panoramaViewer exists, destroy it before re-initializing
			if (panoramaViewer) {
				panoramaViewer.destroy();
				panoramaViewer = null;
			}
			initPanoramaViewer(); // Re-initialize with the new panorama
			initialPanoramaUrl = newPanoramaUrl; // Update initial URL
		}
	});

	// Listen for a custom event from the VR viewer to exit VR (if it's implemented to dispatch such an event)
	const vrViewerElement = document.getElementById('viewer');
	if (vrViewerElement) {
		vrViewerElement.addEventListener('exitvrrequest', () => {
			console.log("app.js: 'exitvrrequest' event received from VR viewer. Calling exitVR().");
			exitVR();
		});
	}
});
