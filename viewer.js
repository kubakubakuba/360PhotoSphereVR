import * as THREE from 'three';

export class Viewer {
	constructor(options) {
		this.container = document.getElementById(options.containerId);
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
		// mouseX, mouseY, lastMouseX, lastMouseY are not strictly needed if only targetRotation is used
		// this.mouseX = 0; 
		// this.mouseY = 0;
		this.lastMouseX = 0;
		this.lastMouseY = 0;

		// Gallery variables
		this.galleryData = [];
		this.galleryVisible = false;
		this.galleryItems = []; // This will store all raycastable objects in the gallery (thumbnails + buttons)
		this.galleryGroup = new THREE.Group(); // Parent group for all gallery elements

		this.galleryToggleTimeout = null;

		// VR Controllers
		this.controller1 = null;
		this.controller2 = null;
		this.controllerGrip1 = null;
		this.controllerGrip2 = null;

		// Gallery pagination and interaction
		this.galleryCurrentPage = 0;
		this.galleryItemsPerPage = 6;
		this.galleryButtonSize = new THREE.Vector2(0.3, 0.1); // Adjusted for text
		this.galleryButtonTextHeight = 32; // Font size for button text
		this.lastJoyY = [0, 0];
		this.joyThreshold = 0.7;
		this.canScrollTimeout = [null, null];

		// Highlight properties
		this.highlightedItem = null;
		this.pointerRaycaster = new THREE.Raycaster(); // For hover detection
		this.highlightMaterial = new THREE.LineBasicMaterial({ color: 0xffff00, linewidth: 2 }); // Yellow border

		// Bound event handlers
		this.boundOnMouseDown = this.onMouseDown.bind(this);
		this.boundOnMouseMove = this.onMouseMove.bind(this);
		this.boundOnMouseUp = this.onMouseUp.bind(this);
		this.boundOnMouseWheel = this.onMouseWheel.bind(this);
		this.boundOnTouchStart = this.onTouchStart.bind(this);
		this.boundOnTouchMove = this.onTouchMove.bind(this);
		this.boundOnTouchEnd = this.onTouchEnd.bind(this);
		this.boundOnResize = this.onResize.bind(this);
		this.boundOnKeyDown = this.onKeyDown.bind(this);
		this.boundOnKeyUp = this.onKeyUp.bind(this);
		// Controller bound handlers will be set in setupControllers

		this.initViewer();
	}

	// Helper function to create text textures
	createTextTexture(text, widthPx, heightPx, options = {}) {
		const canvas = document.createElement('canvas');
		canvas.width = widthPx;
		canvas.height = heightPx;
		const context = canvas.getContext('2d');

		context.fillStyle = options.backgroundColor || 'rgba(0,0,0,0.7)'; // Semi-transparent dark background
		context.fillRect(0, 0, canvas.width, canvas.height);

		context.font = options.font || `${this.galleryButtonTextHeight}px Arial`;
		context.fillStyle = options.textColor || 'white';
		context.textAlign = 'center';
		context.textBaseline = 'middle';

		context.fillText(text, canvas.width / 2, canvas.height / 2);

		const texture = new THREE.CanvasTexture(canvas);
		texture.needsUpdate = true;
		return texture;
	}

	async initViewer() {
		try {
			console.log('Initializing VR Viewer...');
			this.scene = new THREE.Scene();
			this.camera = new THREE.PerspectiveCamera(75, this.container.clientWidth / this.container.clientHeight, 0.1, 1000);
			this.camera.position.set(0, 0, 0.1);

			this.renderer = new THREE.WebGLRenderer({ antialias: true });
			this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
			this.renderer.setPixelRatio(window.devicePixelRatio);
			this.renderer.xr.enabled = true;

			this.container.innerHTML = '';
			this.container.appendChild(this.renderer.domElement);

			const geometry = new THREE.SphereGeometry(1000, 256, 128);
			geometry.scale(-1, 1, 1);

			const loader = new THREE.TextureLoader();
			loader.load(
				this.panoramaPath,
				(texture) => {
					console.log('VR Viewer texture loaded successfully');
					texture.minFilter = THREE.LinearMipmapLinearFilter;
					texture.magFilter = THREE.LinearFilter;
					texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
					texture.needsUpdate = true;
					const material = new THREE.MeshBasicMaterial({ map: texture });
					this.sphere = new THREE.Mesh(geometry, material);
					this.scene.add(this.sphere);
					this.updateStatus('renderer-status', 'VR Renderer ready', 'ok');
				},
				(progress) => console.log('VR texture loading progress:', (progress.loaded / progress.total * 100) + '%'),
				(error) => {
					console.error('Error loading VR texture:', error);
					this.updateStatus('renderer-status', 'Error loading panorama image', 'error');
				}
			);

			this.setupControllers(); 
			this.addEventListeners();

			await this.loadGalleryData();
			this.createGallery(); 

			console.log('VR Viewer initialized successfully');
		} catch (error) {
			console.error('Error initializing VR viewer:', error);
			this.updateStatus('renderer-status', `VR Init Error: ${error.message}`, 'error');
		}
	}

	setupControllers() {
		console.log("Setting up controllers...");
		this.controller1 = this.renderer.xr.getController(0);
		if (this.controller1) {
			this.scene.add(this.controller1);
			this.boundOnSelectStartC1 = (event) => {
				console.log("Viewer: Controller 1 SELECTSTART event raw fire");
				this.onSelectStart(this.controller1, event);
			};
			this.boundOnSqueezeStartC1 = (event) => {
				console.log("Viewer: Controller 1 SQUEEZESTART event raw fire");
				this.onSqueezeStart(event);
			};
			const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
			const lineGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -0.5)]);
			this.controller1.add(new THREE.Line(lineGeometry, lineMaterial));
			console.log("Controller 1 setup.");
		} else {
			console.warn("Controller 1 not available at setup.");
		}

		this.controller2 = this.renderer.xr.getController(1);
		if (this.controller2) {
			this.scene.add(this.controller2);
			this.boundOnSelectStartC2 = (event) => {
				console.log("Viewer: Controller 2 SELECTSTART event raw fire");
				this.onSelectStart(this.controller2, event);
			};
			this.boundOnSqueezeStartC2 = (event) => {
				console.log("Viewer: Controller 2 SQUEEZESTART event raw fire");
				this.onSqueezeStart(event);
			};
			const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff }); 
			const lineGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -0.5)]);
			this.controller2.add(new THREE.Line(lineGeometry, lineMaterial.clone()));
			console.log("Controller 2 setup.");
		} else {
			console.warn("Controller 2 not available at setup.");
		}

		this.controllerGrip1 = this.renderer.xr.getControllerGrip(0);
		if (this.controllerGrip1) this.scene.add(this.controllerGrip1);
		this.controllerGrip2 = this.renderer.xr.getControllerGrip(1);
		if (this.controllerGrip2) this.scene.add(this.controllerGrip2);
	}

	addEventListeners() {
		console.log("Adding event listeners...");
		// Non-VR listeners
		this.container.addEventListener('mousedown', this.boundOnMouseDown);
		this.container.addEventListener('mousemove', this.boundOnMouseMove);
		this.container.addEventListener('mouseup', this.boundOnMouseUp);
		this.container.addEventListener('wheel', this.boundOnMouseWheel);
		this.container.addEventListener('touchstart', this.boundOnTouchStart);
		this.container.addEventListener('touchmove', this.boundOnTouchMove);
		this.container.addEventListener('touchend', this.boundOnTouchEnd);
		window.addEventListener('resize', this.boundOnResize);
		window.addEventListener('keydown', this.boundOnKeyDown);
		window.addEventListener('keyup', this.boundOnKeyUp);
		console.log("Keyboard listeners added.");

		// VR Controller Events
		if (this.controller1 && this.boundOnSelectStartC1 && this.boundOnSqueezeStartC1) {
			this.controller1.addEventListener('selectstart', this.boundOnSelectStartC1);
			this.controller1.addEventListener('squeezestart', this.boundOnSqueezeStartC1);
			console.log("Controller 1 event listeners added.");
		} else {
			console.warn("Could not add listeners for Controller 1 (controller or bound handlers missing).");
		}

		if (this.controller2 && this.boundOnSelectStartC2 && this.boundOnSqueezeStartC2) {
			this.controller2.addEventListener('selectstart', this.boundOnSelectStartC2);
			this.controller2.addEventListener('squeezestart', this.boundOnSqueezeStartC2);
			console.log("Controller 2 event listeners added.");
		} else {
			console.warn("Could not add listeners for Controller 2 (controller or bound handlers missing).");
		}
	}
	
	onSqueezeStart(event) { // Handles gallery toggle
		// Debounce gallery toggle
		if (!this.galleryToggleTimeout) {
			this.toggleGalleryVisibility();
			this.galleryToggleTimeout = setTimeout(() => {
				this.galleryToggleTimeout = null;
			}, 300); // 300ms delay to prevent rapid toggling
		}
	}

	onSelectStart(controller, event) {
		try {
			console.log("Viewer: onSelectStart triggered by a controller");
			if (this.galleryVisible && controller) {
				const raycaster = new THREE.Raycaster(); // Use a local raycaster for selection
				const tempMatrix = new THREE.Matrix4();

				tempMatrix.identity().extractRotation(controller.matrixWorld);
				raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
				raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

				// Intersect with the items themselves, not recursively searching children of items
				const intersects = raycaster.intersectObjects(this.galleryItems, false); 
				console.log("Viewer: Raycast intersects in onSelectStart:", intersects.length);

				if (intersects.length > 0) {
					const intersectedObject = intersects[0].object; // The mesh itself
					if (intersectedObject.userData.path) {
						console.log("Viewer: Gallery item selected with path:", intersectedObject.userData.path);
						this.onGalleryItemSelected(intersectedObject.userData.path);
					} else if (intersectedObject.userData.action) {
						console.log("Viewer: Gallery action selected:", intersectedObject.userData.action);
						this.handleGalleryAction(intersectedObject.userData.action);
					}
				}
			} else {
				console.log("Viewer: onSelectStart: Gallery not visible or controller missing.");
			}
		} catch (error) {
			console.error("Error in onSelectStart:", error);
		}
	}

	handleGalleryAction(action) {
		switch (action) {
			case 'nextPage':
				this.goToNextGalleryPage();
				break;
			case 'prevPage':
				this.goToPrevGalleryPage();
				break;
			case 'exitVR':
				this.requestExitVR();
				break;
		}
	}

	goToNextGalleryPage() {
		const totalPages = Math.ceil(this.galleryData.length / this.galleryItemsPerPage);
		if (this.galleryCurrentPage < totalPages - 1) {
			this.galleryCurrentPage++;
			this.createGallery();
		}
		console.log("Viewer: Next Page. Current Page:", this.galleryCurrentPage);
	}

	goToPrevGalleryPage() {
		if (this.galleryCurrentPage > 0) {
			this.galleryCurrentPage--;
			this.createGallery();
		}
		console.log("Viewer: Prev Page. Current Page:", this.galleryCurrentPage);
	}

	requestExitVR() {
		console.log("Viewer: Requesting VR Exit...");
		if (this.container) { // Ensure container exists
			this.container.dispatchEvent(new CustomEvent('exitvrrequest', { bubbles: true }));
		}
		this.toggleGalleryVisibility(); // Hide gallery
	}

	async loadGalleryData() {
		try {
			const response = await fetch('gallery.json');
			if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
			this.galleryData = await response.json();
			console.log('Gallery data loaded:', this.galleryData.length);
		} catch (error) {
			console.error("Could not load gallery data:", error);
		}
	}

	createGallery() {
		console.log("Viewer: Creating/refreshing gallery. Page:", this.galleryCurrentPage, "Visible:", this.galleryVisible);
		
		this.galleryItems.forEach(item => {
			if (item.geometry) item.geometry.dispose();
			if (item.material) {
				if (item.material.map) item.material.map.dispose();
				item.material.dispose();
			}
			this.galleryGroup.remove(item);
		});
		this.galleryItems = [];
		while(this.galleryGroup.children.length > 0){ 
			this.galleryGroup.remove(this.galleryGroup.children[0]); 
		}

		if (!this.galleryData || this.galleryData.length === 0) {
			console.warn('No gallery data to create gallery.');
			return;
		}

		// Gallery position and orientation are now set in toggleGalleryVisibility
		// this.galleryGroup.position.set(0, 1.6, -1.5); 
		this.galleryGroup.visible = this.galleryVisible;
		if (!this.galleryGroup.parent) this.scene.add(this.galleryGroup);

		const textureLoader = new THREE.TextureLoader();
		
		const startIndex = this.galleryCurrentPage * this.galleryItemsPerPage;
		const endIndex = startIndex + this.galleryItemsPerPage;
		const itemsToDisplay = this.galleryData.slice(startIndex, endIndex);
		
		const itemSize = 0.3; 
		const spacing = 0.05; 
		const itemsPerRow = 3;
		const itemOffsetY = 0.25; // Adjusted offset for thumbnails

		itemsToDisplay.forEach((item, index) => {
			const row = Math.floor(index / itemsPerRow);
			const col = index % itemsPerRow;
			const x = (col - (itemsPerRow - 1) / 2) * (itemSize + spacing);
			const y = ((itemsPerRow - 1) / 2 - row) * (itemSize + spacing) + itemOffsetY;

			const geometry = new THREE.PlaneGeometry(itemSize, itemSize);
			const material = new THREE.MeshBasicMaterial({
				map: textureLoader.load(item.thumbnail || 'placeholder_thumbnail.png'),
				side: THREE.DoubleSide,
				transparent: true 
			});
			const mesh = new THREE.Mesh(geometry, material);
			mesh.position.set(x, y, 0);
			mesh.userData = { path: item.path, isGalleryItem: true, originalMaterial: material.clone() }; // Store original material if needed later
			this.galleryItems.push(mesh);
			this.galleryGroup.add(mesh);
		});

		const buttonY = -0.25; // Adjusted Y position for buttons
		const totalPages = Math.ceil(this.galleryData.length / this.galleryItemsPerPage);
		const buttonTextureWidthPx = 256; // Canvas width for texture
		const buttonTextureHeightPx = 64; // Canvas height for texture

		// Previous Button
		if (this.galleryCurrentPage > 0) {
			const prevButtonGeo = new THREE.PlaneGeometry(this.galleryButtonSize.x, this.galleryButtonSize.y);
			const prevTexture = this.createTextTexture("Prev", buttonTextureWidthPx, buttonTextureHeightPx, { backgroundColor: 'rgba(0, 123, 255, 0.7)'});
			const prevButtonMat = new THREE.MeshBasicMaterial({ map: prevTexture, side: THREE.DoubleSide, transparent: true });
			const prevButton = new THREE.Mesh(prevButtonGeo, prevButtonMat);
			prevButton.position.set(-this.galleryButtonSize.x - spacing, buttonY, 0.01); // Slight Z offset
			prevButton.userData = { action: 'prevPage', isGalleryButton: true, originalMaterial: prevButtonMat.clone() };
			this.galleryItems.push(prevButton);
			this.galleryGroup.add(prevButton);
		}

		// Exit VR Button
		const exitButtonGeo = new THREE.PlaneGeometry(this.galleryButtonSize.x, this.galleryButtonSize.y);
		const exitTexture = this.createTextTexture("Exit VR", buttonTextureWidthPx, buttonTextureHeightPx, { backgroundColor: 'rgba(220, 53, 69, 0.7)'});
		const exitButtonMat = new THREE.MeshBasicMaterial({ map: exitTexture, side: THREE.DoubleSide, transparent: true });
		const exitButton = new THREE.Mesh(exitButtonGeo, exitButtonMat);
		exitButton.position.set(0, buttonY, 0.01); // Centered, slight Z offset
		exitButton.userData = { action: 'exitVR', isGalleryButton: true, originalMaterial: exitButtonMat.clone() };
		this.galleryItems.push(exitButton);
		this.galleryGroup.add(exitButton);

		// Next Button
		if (this.galleryCurrentPage < totalPages - 1) {
			const nextButtonGeo = new THREE.PlaneGeometry(this.galleryButtonSize.x, this.galleryButtonSize.y);
			const nextTexture = this.createTextTexture("Next", buttonTextureWidthPx, buttonTextureHeightPx, { backgroundColor: 'rgba(0, 123, 255, 0.7)'});
			const nextButtonMat = new THREE.MeshBasicMaterial({ map: nextTexture, side: THREE.DoubleSide, transparent: true });
			const nextButton = new THREE.Mesh(nextButtonGeo, nextButtonMat);
			nextButton.position.set(this.galleryButtonSize.x + spacing, buttonY, 0.01); // Slight Z offset
			nextButton.userData = { action: 'nextPage', isGalleryButton: true, originalMaterial: nextButtonMat.clone() };
			this.galleryItems.push(nextButton);
			this.galleryGroup.add(nextButton);
		}
		console.log("Viewer: Gallery created with items:", this.galleryItems.length, "on page", this.galleryCurrentPage);
	}

	addHighlight(item) {
		if (!item || item.userData.highlightBorder) return;

		// Ensure item has geometry
		if (!item.geometry) {
			console.warn("Viewer: Item has no geometry to create highlight border.", item);
			return;
		}

		const edges = new THREE.EdgesGeometry(item.geometry);
		const line = new THREE.LineSegments(edges, this.highlightMaterial);
		line.renderOrder = 1; // Attempt to render on top
		line.userData.isHighlight = true; // Mark this as a highlight object

		item.userData.highlightBorder = line;
		item.add(line); // Add border as a child of the item
		// console.log("Viewer: Added highlight to", item.userData.path || item.userData.action);
	}

	removeHighlight(item) {
		if (item && item.userData.highlightBorder) {
			item.remove(item.userData.highlightBorder);
			item.userData.highlightBorder.geometry.dispose();
			// Material is shared (this.highlightMaterial), so don't dispose it here unless it's unique per highlight
			item.userData.highlightBorder = null;
			// console.log("Viewer: Removed highlight from", item.userData.path || item.userData.action);
		}
	}

	onGalleryItemSelected(path) {
		// ... (from previous correct version)
		console.log('Viewer: Selected panorama:', path);
		this.loadNewPanorama(path);
		if (this.galleryVisible) {
			this.toggleGalleryVisibility(); 
		}
	}

	async loadNewPanorama(path) {
		// ... (from previous correct version)
		const loader = new THREE.TextureLoader();
		loader.load(
			path,
			(texture) => {
				console.log('New VR Viewer texture loaded successfully');
				texture.minFilter = THREE.LinearMipmapLinearFilter;
				texture.magFilter = THREE.LinearFilter;
				texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
				texture.needsUpdate = true;
				this.sphere.material.map = texture;
				this.sphere.material.needsUpdate = true;
			},
			(progress) => console.log('VR texture loading progress:', (progress.loaded / progress.total * 100) + '%'),
			(error) => {
				console.error('Error loading VR texture:', error);
				this.updateStatus('renderer-status', 'Error loading panorama image', 'error');
			}
		);
	}

	toggleGalleryVisibility() {
		this.galleryVisible = !this.galleryVisible;
		console.log('Viewer: Toggling gallery visibility to:', this.galleryVisible);

		if (this.galleryVisible) {
			// Position gallery in front of the camera
			const distance = 1.5; // How far in front the gallery should appear
			const cameraDirection = new THREE.Vector3();
			this.camera.getWorldDirection(cameraDirection);
			
			const galleryPosition = new THREE.Vector3();
			galleryPosition.copy(this.camera.position).add(cameraDirection.multiplyScalar(distance));
			
			this.galleryGroup.position.copy(galleryPosition);
			
			// Orient gallery to face the camera, but keep its Y-axis aligned with world's Y
			// Store current camera Y rotation
			const currentCameraQuaternion = this.camera.quaternion.clone();
			// Create a target for the gallery to look at, slightly behind the camera along its view direction
			// This helps in making the gallery face the camera more directly.
			const lookAtTarget = new THREE.Vector3().copy(this.camera.position).sub(cameraDirection.multiplyScalar(0.1)); // cameraDirection was already multiplied
			this.galleryGroup.lookAt(lookAtTarget);


			this.galleryCurrentPage = 0; 
			this.createGallery(); 
		} else {
			if (this.galleryGroup) {
				this.galleryGroup.visible = false;
			}
		}
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
		this.targetRotationX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.targetRotationX));
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
			this.targetRotationX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.targetRotationX));
			this.lastMouseX = event.touches[0].clientX;
			this.lastMouseY = event.touches[0].clientY;
		}
	}

	onTouchEnd(event) {
		this.isMouseDown = false;
	}

	onKeyDown(event) {
		// ... (from previous correct version, including 'G' key for onSqueezeStart)
		try {
			if (event.code === 'KeyG') {
				if (event.repeat) return;
				console.log("Viewer: G key pressed - simulating squeeze start for gallery toggle");
				this.onSqueezeStart(); 
			}
			if (!this.renderer.xr.isPresenting) {
				switch (event.code) {
					case 'ArrowLeft': this.isRotatingLeft = true; break;
					case 'ArrowRight': this.isRotatingRight = true; break;
				}
			}
		} catch (error) {
			console.error("Error in onKeyDown:", error);
		}
	}

	onKeyUp(event) {
		// ... (from previous correct version)
		if (!this.renderer.xr.isPresenting) {
			switch (event.code) {
				case 'ArrowLeft': this.isRotatingLeft = false; break;
				case 'ArrowRight': this.isRotatingRight = false; break;
			}
		}
	}

	onResize() {
		// ... (from previous correct version)
		if (!this.renderer || !this.camera) return;
		const width = this.container.clientWidth;
		const height = this.container.clientHeight;
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(width, height);
		console.log("Viewer: Resized viewer to:", width, height);
	}

	render() {
		try {
			if (!this.renderer || !this.scene || !this.camera) return;

			let needsRender = true; // Flag to check if rendering is needed

			if (this.renderer.xr.isPresenting) {
				if (this.galleryVisible) {
					// Joystick scrolling logic (no changes here)
					for (let i = 0; i < 2; i++) {
						const controller = i === 0 ? this.controller1 : this.controller2;
						if (controller && controller.gamepad && controller.gamepad.axes.length > 3) {
							const currentY = controller.gamepad.axes[3];
							if (!this.canScrollTimeout[i]) {
								if (currentY > this.joyThreshold && this.lastJoyY[i] <= this.joyThreshold) {
									this.goToNextGalleryPage();
									this.canScrollTimeout[i] = setTimeout(() => { this.canScrollTimeout[i] = null; }, 300);
								} else if (currentY < -this.joyThreshold && this.lastJoyY[i] >= -this.joyThreshold) {
									this.goToPrevGalleryPage();
									this.canScrollTimeout[i] = setTimeout(() => { this.canScrollTimeout[i] = null; }, 300);
								}
							}
							this.lastJoyY[i] = currentY;
						}
					}

					// Hover highlight logic
					let pointingController = null;
					if (this.controller1 && this.controller1.visible) pointingController = this.controller1; // Prefer controller1 if visible
					else if (this.controller2 && this.controller2.visible) pointingController = this.controller2;

					if (pointingController) {
						const tempMatrix = new THREE.Matrix4();
						tempMatrix.identity().extractRotation(pointingController.matrixWorld);
						this.pointerRaycaster.ray.origin.setFromMatrixPosition(pointingController.matrixWorld);
						this.pointerRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

						const intersects = this.pointerRaycaster.intersectObjects(this.galleryItems, false);

						let currentlyIntersectedItem = null;
						if (intersects.length > 0) {
							// Find the first actual gallery item or button, not a highlight border itself
							for (const intersect of intersects) {
								if (intersect.object && (intersect.object.userData.isGalleryItem || intersect.object.userData.isGalleryButton)) {
									currentlyIntersectedItem = intersect.object;
									break;
								}
							}
						}

						if (this.highlightedItem && this.highlightedItem !== currentlyIntersectedItem) {
							this.removeHighlight(this.highlightedItem);
							this.highlightedItem = null;
						}

						if (currentlyIntersectedItem && currentlyIntersectedItem !== this.highlightedItem) {
							this.addHighlight(currentlyIntersectedItem);
							this.highlightedItem = currentlyIntersectedItem;
						}
					} else if (this.highlightedItem) { // No active pointing controller, remove highlight
						this.removeHighlight(this.highlightedItem);
						this.highlightedItem = null;
					}
				} else if (this.highlightedItem) { // Gallery not visible, remove highlight
					this.removeHighlight(this.highlightedItem);
					this.highlightedItem = null;
				}
			} else { // Not in VR
				if (this.highlightedItem) { // Remove highlight if exiting VR or gallery closed
					this.removeHighlight(this.highlightedItem);
					this.highlightedItem = null;
				}
				// Non-VR rotation update
				if (this.sphere) {
					this.sphere.rotation.y += (this.targetRotationY - this.sphere.rotation.y) * 0.1;
					this.sphere.rotation.x += (this.targetRotationX - this.sphere.rotation.x) * 0.1;
				}
				if (this.isRotatingLeft) this.sphere.rotation.y += this.vrRotationSpeed;
				if (this.isRotatingRight) this.sphere.rotation.y -= this.vrRotationSpeed;
			}

			if (needsRender) {
				this.renderer.render(this.scene, this.camera);
			}
		} catch (error) {
			console.error("Error in Viewer.render():", error);
			if (this.renderer && this.renderer.xr && this.renderer.xr.getSession()) {
				console.error("Attempting to end XR session due to render error.");
				this.renderer.xr.getSession().end().catch(e => console.error("Error ending session:", e));
			}
		}
	}

	updateStatus(elementId, message, type = '') {
		const element = document.getElementById(elementId);
		const indicator = document.getElementById(elementId + '-indicator');
		if (element) element.textContent = message;
		if (indicator) indicator.className = `status-indicator status-${type}`;
	}

	// Ensure this method exists and is not commented out
	setReferenceSpaceInfo(info) {
		const element = document.getElementById('reference-space'); // Make sure 'reference-space' element exists in your HTML
		if (element) {
			element.textContent = `Reference Space: ${info}`;
		} else {
			console.warn("Element with ID 'reference-space' not found for setReferenceSpaceInfo.");
		}
	}

	updateCameraOrientation(x, y, z, status = 'ok') { // Example of another utility function
		const statusElement = document.getElementById('camera-status');
		if (statusElement) {
			statusElement.textContent = `Camera: X:${x.toFixed(2)} Y:${y.toFixed(2)} Z:${z.toFixed(2)}`;
		}
		const indicator = document.getElementById('camera-status-indicator');
		if (indicator) {
			indicator.className = `status-indicator status-${status}`;
		}
	}

	// ... other utility functions like showVrLoading, hideVrLoading, updateProgress ...

	destroy() {
		console.log("Destroying VR Viewer...");
		// Remove controller event listeners using the stored bound handlers
		if (this.controller1) {
			if (this.boundOnSelectStartC1) this.controller1.removeEventListener('selectstart', this.boundOnSelectStartC1);
			if (this.boundOnSqueezeStartC1) this.controller1.removeEventListener('squeezestart', this.boundOnSqueezeStartC1);
		}
		if (this.controller2) {
			if (this.boundOnSelectStartC2) this.controller2.removeEventListener('selectstart', this.boundOnSelectStartC2);
			if (this.boundOnSqueezeStartC2) this.controller2.removeEventListener('squeezestart', this.boundOnSqueezeStartC2);
		}

		// Remove general listeners using the stored bound handlers
		this.container.removeEventListener('mousedown', this.boundOnMouseDown);
		this.container.removeEventListener('mousemove', this.boundOnMouseMove);
		this.container.removeEventListener('mouseup', this.boundOnMouseUp);
		this.container.removeEventListener('wheel', this.boundOnMouseWheel);
		this.container.removeEventListener('touchstart', this.boundOnTouchStart);
		this.container.removeEventListener('touchmove', this.boundOnTouchMove);
		this.container.removeEventListener('touchend', this.boundOnTouchEnd);
		window.removeEventListener('resize', this.boundOnResize);
		window.removeEventListener('keydown', this.boundOnKeyDown);
		window.removeEventListener('keyup', this.boundOnKeyUp);
		console.log("General event listeners removed.");

		// Remove any active highlight
		if (this.highlightedItem) {
			this.removeHighlight(this.highlightedItem);
			this.highlightedItem = null;
		}
		// Dispose shared highlight material if it's not used elsewhere
		if (this.highlightMaterial) {
			this.highlightMaterial.dispose();
			this.highlightMaterial = null;
		}


		// Dispose Three.js objects
		if (this.renderer) {
			this.renderer.dispose();
			if (this.container && this.renderer.domElement && this.container.contains(this.renderer.domElement)) {
				this.container.removeChild(this.renderer.domElement);
			}
			this.renderer = null;
		}
		if (this.sphere) {
			if (this.sphere.material) {
				if (this.sphere.material.map) this.sphere.material.map.dispose();
				this.sphere.material.dispose();
			}
			if (this.sphere.geometry) this.sphere.geometry.dispose();
			if (this.scene) this.scene.remove(this.sphere); // Check if scene exists
			this.sphere = null;
		}
		if (this.galleryGroup) {
			this.galleryItems.forEach(item => {
				if (item.geometry) item.geometry.dispose();
				if (item.material) {
					if (item.material.map) item.material.map.dispose();
					item.material.dispose();
				}
				this.galleryGroup.remove(item);
			});
			this.galleryItems = [];
			if (this.galleryGroup.parent) this.galleryGroup.parent.remove(this.galleryGroup);
		}
		if(this.controller1 && this.controller1.parent) this.controller1.parent.remove(this.controller1);
		if(this.controller2 && this.controller2.parent) this.controller2.parent.remove(this.controller2);
		if(this.controllerGrip1 && this.controllerGrip1.parent) this.controllerGrip1.parent.remove(this.controllerGrip1);
		if(this.controllerGrip2 && this.controllerGrip2.parent) this.controllerGrip2.parent.remove(this.controllerGrip2);

		// Clear timeouts for joystick scroll debounce
		if (this.canScrollTimeout) {
			clearTimeout(this.canScrollTimeout[0]);
			clearTimeout(this.canScrollTimeout[1]);
		}


		this.scene = null;
		this.camera = null;
		
		console.log('VR Viewer destroyed and resources cleaned up.');
	}
}

export default Viewer;