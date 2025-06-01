function animateNonVR() {
	if (viewer.renderer && !viewer.renderer.xr.isPresenting) {
		viewer.camera.rotation.y += (viewer.targetRotationY - viewer.camera.rotation.y) * 0.1;
		viewer.camera.rotation.x += (viewer.targetRotationX - viewer.camera.rotation.x) * 0.1;

		viewer.updateCameraOrientation(viewer.camera.rotation.x, viewer.camera.rotation.y, viewer.camera.rotation.z, 'ok');

		viewer.render();
		nonVrAnimationFrameId = requestAnimationFrame(animateNonVR);
	} else {
		nonVrAnimationFrameId = null; 
	}
}

if (viewer.renderer) {
	animateNonVR();
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


async function enterVR() {
	if (!viewer.renderer || !viewer.renderer.xr) {
		viewer.updateStatus('session-status', 'Error: Renderer or XR module not ready.', 'error');
		console.error("Renderer or XR module not initialized.");
		return;
	}

	viewer.updateStatus('session-status', 'Attempting to start VR session...', 'warning');
	viewer.showVrLoading('Initializing VR Experience...');
	viewer.updateProgress(10, 'Checking VR capabilities...');
	console.log('Attempting to enter VR...');

	try {
		if (!navigator.xr) {
			throw new Error('WebXR API not available.');
		}

		viewer.updateProgress(20, 'Verifying session support...');
		const immersiveSupported = await navigator.xr.isSessionSupported('immersive-vr');
		if (!immersiveSupported) {
			throw new Error('Immersive VR session not supported on this device.');
		}
		console.log('Immersive VR supported.');

		viewer.updateProgress(30, 'Requesting VR session...');
		const session = await navigator.xr.requestSession('immersive-vr');
		vrSession = session;
		console.log('XR session obtained:', session);

		viewer.renderer.xr.enabled = true;
		console.log('Three.js XR manager enabled.');

		viewer.updateProgress(40, 'Finding supported reference space...');
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
		viewer.setReferenceSpaceInfo(selectedSpaceType);
		viewer.updateProgress(50, `Using reference space: ${selectedSpaceType}`);

		viewer.renderer.xr.setReferenceSpaceType(selectedSpaceType);
		console.log(`Three.js WebXRManager referenceSpaceType set to: ${selectedSpaceType}`);

		viewer.updateProgress(60, 'Initializing Three.js XR session...');
		await viewer.renderer.xr.setSession(session);
		console.log('Three.js XR session has been set.');
		
		// Stop the non-VR animation loop when entering VR
		if (nonVrAnimationFrameId) {
			cancelAnimationFrame(nonVrAnimationFrameId);
			nonVrAnimationFrameId = null;
		}

		// Add keyboard listeners for VR rotation
		window.addEventListener('keydown', viewer.onKeyDown.bind(viewer));
		window.addEventListener('keyup', viewer.onKeyUp.bind(viewer));


		viewer.updateProgress(80, 'Starting VR rendering loop...');
		viewer.renderer.setAnimationLoop((timestamp, frame) => {
			if (!frame) { 
				return;
			}
			if (viewer.isRotatingLeft) {
				viewer.sphere.rotation.y += viewer.vrRotationSpeed;
			}
			if (viewer.isRotatingRight) {
				viewer.sphere.rotation.y -= viewer.vrRotationSpeed;
			}

			const rotation = viewer.camera.rotation;
			viewer.updateCameraOrientation(rotation.x, rotation.y, rotation.z);
			viewer.render(); 
		});
		console.log('VR animation loop started.');

		enterVrBtn.disabled = true;
		exitVrBtn.disabled = false;
		viewer.updateStatus('session-status', 'VR session active', 'ok');
		viewer.updateProgress(100, 'VR Ready!');

		setTimeout(() => {
			viewer.hideVrLoading();
		}, 1000); 

		session.addEventListener('end', () => {
			console.log('XR session ended event received.');
			onXRSessionEnded(); 
		});

	} catch (error) {
		console.error('Error entering VR:', error);
		viewer.updateStatus('session-status', `VR Error: ${error.message}`, 'error');
		viewer.loadingText.textContent = `VR Initialization Failed: ${error.message}`;
		viewer.updateProgress(0, ''); 
		
		setTimeout(() => {
			viewer.hideVrLoading();
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
	if (viewer.renderer && viewer.renderer.xr) {
		viewer.renderer.xr.enabled = false; 
		if (viewer.renderer.setAnimationLoop) { 
			viewer.renderer.setAnimationLoop(null); 
		}
	}
	
	enterVrBtn.disabled = false;
	exitVrBtn.disabled = true;
	viewer.updateStatus('session-status', 'No active VR session');
	viewer.setReferenceSpaceInfo('Not set');
	viewer.updateCameraOrientation(0, 0, 0, 'warning'); // Reset camera status on exit
	
	vrSession = null; 
	currentXrReferenceSpace = null; 

	// Remove keyboard listeners when exiting VR
	window.removeEventListener('keydown', viewer.onKeyDown);
	window.removeEventListener('keyup', viewer.onKeyUp);
	viewer.isRotatingLeft = false; // Reset rotation states
	viewer.isRotatingRight = false;


	viewer.hideVrLoading(); 
	// Reset camera position and rotation for non-VR view
	viewer.camera.position.set(0, 0, 0.1); 
	viewer.camera.rotation.set(0, 0, 0); 
	viewer.targetRotationX = 0; // Reset target rotations for mouse controls
	viewer.targetRotationY = 0;
	viewer.onResize(); 
	animateNonVR(); // Restart the non-VR animation loop
	console.log('Cleaned up XR session resources.');
}

async function exitVR() { 
	console.log('Attempting to exit VR...');
	viewer.showVrLoading('Exiting VR...');
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