import * as THREE from 'three';

export class Viewer {
	constructor(options) {
		this.container = document.getElementById(options.container);
		this.panoramaPath = options.panorama;
		this.caption = options.caption;
		
		this.camera = null;
		this.scene = null;
		this.renderer = null;
		this.sphere = null;
		
		this.targetRotationX = 0;
		this.targetRotationY = 0;
		
		this.isRotatingLeft = false;
		this.isRotatingRight = false;
		this.vrRotationSpeed = 0.02;
		
		this.isMouseDown = false;
		this.mouseX = 0;
		this.mouseY = 0;
		this.lastMouseX = 0;
		this.lastMouseY = 0;
		
		this.loadingText = document.getElementById('loading-text');
		
		this.initViewer();
	}
	
	initViewer() {
		try {
			console.log('Initializing VR Viewer...');
			
			// Create scene
			this.scene = new THREE.Scene();
			
			// Create camera
			this.camera = new THREE.PerspectiveCamera(75, this.container.clientWidth / this.container.clientHeight, 0.1, 1000);
			this.camera.position.set(0, 0, 0.1);
			
			// Create renderer
			this.renderer = new THREE.WebGLRenderer({ antialias: true });
			this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
			this.renderer.setPixelRatio(window.devicePixelRatio);
			this.renderer.xr.enabled = false; // Will be enabled when entering VR
			
			// Clear container and append renderer
			this.container.innerHTML = '';
			this.container.appendChild(this.renderer.domElement);
			
			// Create sphere geometry
			const geometry = new THREE.SphereGeometry(500, 60, 40);
			geometry.scale(-1, 1, 1); // Invert to see inside
			
			// Load texture
			const loader = new THREE.TextureLoader();
			loader.load(
				this.panoramaPath,
				(texture) => {
					// Success callback
					console.log('VR Viewer texture loaded successfully');
					const material = new THREE.MeshBasicMaterial({ map: texture });
					this.sphere = new THREE.Mesh(geometry, material);
					this.scene.add(this.sphere);
					
					this.updateStatus('renderer-status', 'VR Renderer ready', 'ok');
					this.render();
				},
				(progress) => {
					// Progress callback
					console.log('VR texture loading progress:', (progress.loaded / progress.total * 100) + '%');
				},
				(error) => {
					// Error callback
					console.error('Error loading VR texture:', error);
					this.updateStatus('renderer-status', 'Error loading panorama image', 'error');
				}
			);
			
			// Add event listeners
			this.addEventListeners();
			
			console.log('VR Viewer initialized successfully');
			
		} catch (error) {
			console.error('Error initializing VR viewer:', error);
			this.updateStatus('renderer-status', `VR Init Error: ${error.message}`, 'error');
		}
	}
	
	addEventListeners() {
		// Mouse events for non-VR interaction
		this.container.addEventListener('mousedown', this.onMouseDown.bind(this));
		this.container.addEventListener('mousemove', this.onMouseMove.bind(this));
		this.container.addEventListener('mouseup', this.onMouseUp.bind(this));
		this.container.addEventListener('wheel', this.onMouseWheel.bind(this));
		
		// Touch events for mobile
		this.container.addEventListener('touchstart', this.onTouchStart.bind(this));
		this.container.addEventListener('touchmove', this.onTouchMove.bind(this));
		this.container.addEventListener('touchend', this.onTouchEnd.bind(this));
		
		// Resize event
		window.addEventListener('resize', this.onResize.bind(this));
	}
	
	onMouseDown(event) {
		this.isMouseDown = true;
		this.lastMouseX = event.clientX;
		this.lastMouseY = event.clientY;
		this.container.style.cursor = 'grabbing';
	}
	
	onMouseMove(event) {
		if (!this.isMouseDown) return;
		
		const deltaX = event.clientX - this.lastMouseX;
		const deltaY = event.clientY - this.lastMouseY;
		
		this.targetRotationY -= deltaX * 0.005;
		this.targetRotationX -= deltaY * 0.005;
		
		// Clamp vertical rotation
		this.targetRotationX = Math.max(-Math.PI/2, Math.min(Math.PI/2, this.targetRotationX));
		
		this.lastMouseX = event.clientX;
		this.lastMouseY = event.clientY;
	}
	
	onMouseUp(event) {
		this.isMouseDown = false;
		this.container.style.cursor = 'grab';
	}
	
	onMouseWheel(event) {
		const fov = this.camera.fov + event.deltaY * 0.05;
		this.camera.fov = Math.max(30, Math.min(90, fov));
		this.camera.updateProjectionMatrix();
	}
	
	onTouchStart(event) {
		if (event.touches.length === 1) {
			this.isMouseDown = true;
			this.lastMouseX = event.touches[0].clientX;
			this.lastMouseY = event.touches[0].clientY;
		}
	}
	
	onTouchMove(event) {
		if (this.isMouseDown && event.touches.length === 1) {
			event.preventDefault();
			
			const deltaX = event.touches[0].clientX - this.lastMouseX;
			const deltaY = event.touches[0].clientY - this.lastMouseY;
			
			this.targetRotationY -= deltaX * 0.005;
			this.targetRotationX -= deltaY * 0.005;
			
			this.targetRotationX = Math.max(-Math.PI/2, Math.min(Math.PI/2, this.targetRotationX));
			
			this.lastMouseX = event.touches[0].clientX;
			this.lastMouseY = event.touches[0].clientY;
		}
	}
	
	onTouchEnd(event) {
		this.isMouseDown = false;
	}
	
	onKeyDown(event) {
		switch(event.code) {
			case 'ArrowLeft':
				this.isRotatingLeft = true;
				break;
			case 'ArrowRight':
				this.isRotatingRight = true;
				break;
		}
	}
	
	onKeyUp(event) {
		switch(event.code) {
			case 'ArrowLeft':
				this.isRotatingLeft = false;
				break;
			case 'ArrowRight':
				this.isRotatingRight = false;
				break;
		}
	}
	
	onResize() {
		if (!this.renderer || !this.camera) return;
		
		const width = this.container.clientWidth;
		const height = this.container.clientHeight;
		
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(width, height);
	}
	
	render() {
		if (!this.renderer || !this.scene || !this.camera) return;
		this.renderer.render(this.scene, this.camera);
	}
	
	updateStatus(elementId, message, type = '') {
		const element = document.getElementById(elementId);
		const indicator = document.getElementById(elementId + '-indicator');
		
		if (element) {
			element.textContent = message;
		}
		
		if (indicator) {
			indicator.className = `status-indicator status-${type}`;
		}
	}
	
	updateCameraOrientation(x, y, z, status = 'ok') {
		const statusElement = document.getElementById('camera-status');
		if (statusElement) {
			statusElement.textContent = `Camera: X:${x.toFixed(2)} Y:${y.toFixed(2)} Z:${z.toFixed(2)}`;
		}
		
		const indicator = document.getElementById('camera-status-indicator');
		if (indicator) {
			indicator.className = `status-indicator status-${status}`;
		}
	}
	
	setReferenceSpaceInfo(info) {
		const element = document.getElementById('reference-space');
		if (element) {
			element.textContent = `Reference Space: ${info}`;
		}
	}
	
	showVrLoading(text) {
		const loading = document.getElementById('vr-loading');
		const loadingText = document.getElementById('loading-text');
		
		if (loadingText && text) {
			loadingText.textContent = text;
		}
		
		if (loading) {
			loading.classList.add('visible');
		}
	}
	
	hideVrLoading() {
		const loading = document.getElementById('vr-loading');
		if (loading) {
			loading.classList.remove('visible');
		}
	}
	
	updateProgress(percent, text) {
		const progressBar = document.getElementById('progress-bar');
		const loadingText = document.getElementById('loading-text');
		
		if (progressBar) {
			progressBar.style.width = percent + '%';
		}
		
		if (loadingText && text) {
			loadingText.textContent = text;
		}
	}
	
	destroy() {
		// Clean up resources
		if (this.renderer) {
			this.renderer.dispose();
			if (this.container && this.renderer.domElement && this.container.contains(this.renderer.domElement)) {
				this.container.removeChild(this.renderer.domElement);
			}
		}
		
		if (this.sphere && this.sphere.material) {
			if (this.sphere.material.map) {
				this.sphere.material.map.dispose();
			}
			this.sphere.material.dispose();
		}
		
		if (this.sphere && this.sphere.geometry) {
			this.sphere.geometry.dispose();
		}
		
		// Remove event listeners
		window.removeEventListener('resize', this.onResize);
		
		console.log('VR Viewer destroyed');
	}
}

// Also export as default for compatibility
export default Viewer;