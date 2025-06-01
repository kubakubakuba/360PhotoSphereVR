class Viewer {
    constructor(options) {
        this.container = document.getElementById(options.container);
        this.panorama = options.panorama || 'https://placehold.co/4096x2048/000000/FFFFFF?text=Panorama+Not+Found'; // Fallback panorama
        this.caption = options.caption || '';
        this.vrLoading = document.getElementById('vr-loading');
        this.loadingText = document.getElementById('loading-text');
        this.progressBar = document.getElementById('progress-bar');
        this.referenceSpaceEl = document.getElementById('reference-space');
        this.cameraStatusEl = document.getElementById('camera-status'); 
        this.cameraStatusIndicator = document.getElementById('camera-status-indicator'); 
        
        this.canvas = document.createElement('canvas');
        this.container.appendChild(this.canvas);
        
        this.updateStatus('renderer-status', 'Initializing renderer...', 'warning');
        this.updateCameraOrientation(0, 0, 0, 'warning'); 
        
        // Mouse control variables for non-VR mode
        this.isDragging = false;
        this.previousMouseX = 0;
        this.previousMouseY = 0;
        this.targetRotationY = 0; // Yaw (horizontal)
        this.targetRotationX = 0; // Pitch (vertical)
        this.rotationSpeed = 0.002; // Sensitivity of mouse rotation

        // VR panorama rotation variables (for keyboard control in VR)
        this.vrRotationSpeed = 0.02; // Speed of panorama rotation in VR
        this.isRotatingLeft = false;
        this.isRotatingRight = false;

        // Add mouse event listeners to the canvas
        this.canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
        this.canvas.addEventListener('mouseout', this.onMouseUp.bind(this)); // Stop dragging if mouse leaves canvas
        
        setTimeout(() => this.initThreeJS(), 100);
    }
    
    initThreeJS() {
        try {
            let gl = this.canvas.getContext('webgl2', { xrCompatible: true });
            if (!gl) {
                gl = this.canvas.getContext('webgl', { xrCompatible: true });
            }
            if (!gl) {
                throw new Error('WebGL context not available or not XR compatible.');
            }

            this.renderer = new THREE.WebGLRenderer({
                canvas: this.canvas,
                context: gl, 
                antialias: true
            });
            this.renderer.setPixelRatio(window.devicePixelRatio);
            
            this.camera = new THREE.PerspectiveCamera(
                75, 
                this.container.clientWidth / this.container.clientHeight, 
                0.1, 
                1000
            );
            
            this.scene = new THREE.Scene();
            
            const geometry = new THREE.SphereGeometry(500, 64, 40);
            geometry.scale(-1, 1, 1); 
            
            this.material = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                side: THREE.DoubleSide 
            });
            
            this.sphere = new THREE.Mesh(geometry, this.material);
            this.scene.add(this.sphere);
            
            this.camera.position.set(0, 0, 0.1); 
            
            this.updateStatus('renderer-status', 'Renderer ready', 'ok');
            
            this.loadPanorama(); // Initial load of the panorama
            
            window.addEventListener('resize', () => this.onResize());
            this.onResize(); 
            
        } catch (error) {
            console.error('Three.js initialization error:', error);
            this.updateStatus('renderer-status', `Renderer error: ${error.message}`, 'error');
            if (this.container) this.container.innerHTML = `<p style="color:red; padding:20px;">Critical Error: Could not initialize 3D renderer. ${error.message}</p>`;
        }
    }
    
    loadPanorama() {
        if (!this.renderer) { 
            this.updateStatus('session-status', 'Cannot load panorama: Renderer not initialized.', 'error');
            return;
        }
        try {
            const loader = new THREE.TextureLoader();
            
            this.showVrLoading('Loading panorama...'); 
            this.updateProgress(10, 'Starting panorama load...');
            
            loader.load(this.panorama, 
                (texture) => { 
                    this.material.map = texture;
                    this.material.needsUpdate = true;
                    this.material.wireframe = false; // Ensure wireframe is off when loading panorama
                    this.material.color.set(0xffffff); // Reset color to white for texture
                    this.render(); 
                    this.updateProgress(100, 'Panorama loaded successfully!');
                    setTimeout(() => this.hideVrLoading(), 1500); 
                }, 
                (xhr) => { 
                    if (xhr.lengthComputable) {
                        const percentComplete = (xhr.loaded / xhr.total) * 100;
                        this.updateProgress(10 + percentComplete * 0.8, `Loading panorama: ${Math.round(percentComplete)}%`);
                    } else {
                        this.updateProgress(50, 'Loading panorama (progress unknown)...');
                    }
                }, 
                (errorEvent) => { 
                    console.error('Failed to load panorama image:', errorEvent);
                    const errorMessage = errorEvent.message || (errorEvent.target && errorEvent.target.src ? `Could not load image from ${errorEvent.target.src}` : 'Unknown error loading image.');
                    this.updateStatus('session-status', `Error: ${errorMessage}`, 'error');
                    this.loadingText.textContent = `Failed to load panorama: ${errorMessage}. Please check the image path/URL and console.`;
                    this.progressBar.style.width = '0%'; 
                    this.material.map = null; 
                    this.material.color.set(0x333333); 
                    this.material.needsUpdate = true;
                    this.render();
                }
            );
        } catch (error) {
            console.error('Panorama loading setup error:', error);
            this.updateStatus('session-status', `Panorama setup error: ${error.message}`, 'error');
            this.hideVrLoading();
        }
    }
    
    render() {
        if (this.renderer && this.scene && this.camera) {
            try {
                this.renderer.render(this.scene, this.camera);
            } catch (error) {
                console.error('Rendering error:', error);
            }
        }
    }
    
    onResize() {
        if (this.renderer && !(this.renderer.xr && this.renderer.xr.isPresenting)) {
            const width = this.container.clientWidth;
            const height = this.container.clientHeight;
            
            if (this.camera) {
                this.camera.aspect = width / height;
                this.camera.updateProjectionMatrix();
            }
            
            this.renderer.setSize(width, height);
            this.render(); 
        }
    }
    
    showVrLoading(message) {
        this.vrLoading.classList.add('visible');
        this.loadingText.textContent = message;
    }
    
    hideVrLoading() {
        this.vrLoading.classList.remove('visible');
    }
    
    updateProgress(percent, message) {
        if (this.vrLoading.classList.contains('visible')) { 
            if (message) this.loadingText.textContent = message;
            this.progressBar.style.width = `${percent}%`;
        }
    }
    
    updateStatus(elementId, message, statusType) {
        const element = document.getElementById(elementId);
        const indicator = document.getElementById(`${elementId}-indicator`);
        
        if (element) element.textContent = message;
        if (indicator) {
            indicator.className = 'status-indicator'; 
            if (statusType) indicator.classList.add(`status-${statusType}`);
        }
    }

    updateCameraOrientation(x, y, z, statusType = 'ok') {
        if (this.cameraStatusEl) {
            this.cameraStatusEl.textContent = `Camera Orientation: Pitch ${THREE.MathUtils.radToDeg(x).toFixed(0)}°, Yaw ${THREE.MathUtils.radToDeg(y).toFixed(0)}°, Roll ${THREE.MathUtils.radToDeg(z).toFixed(0)}°`;
            this.cameraStatusIndicator.className = `status-indicator status-${statusType}`;
        }
    }
    
    setReferenceSpaceInfo(spaceType) { 
        this.referenceSpaceEl.textContent = `Reference Space: ${spaceType || 'Not set'}`;
    }

    // Mouse control methods for non-VR mode
    onMouseDown(event) {
        if (this.renderer.xr.isPresenting) return; 
        this.isDragging = true;
        this.previousMouseX = event.clientX;
        this.previousMouseY = event.clientY;
        this.canvas.style.cursor = 'grabbing'; 
    }

    onMouseMove(event) {
        if (!this.isDragging || this.renderer.xr.isPresenting) return;

        const deltaX = event.clientX - this.previousMouseX;
        const deltaY = event.clientY - this.previousMouseY;

        this.targetRotationY -= deltaX * this.rotationSpeed; 
        this.targetRotationX -= deltaY * this.rotationSpeed; 

        this.targetRotationX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.targetRotationX));

        this.previousMouseX = event.clientX;
        this.previousMouseY = event.clientY;
    }

    onMouseUp() {
        this.isDragging = false;
        this.canvas.style.cursor = 'grab'; 
    }

    // Keyboard control methods for VR mode
    onKeyDown(event) {
        if (!this.renderer.xr.isPresenting) return; // Only active in VR

        switch (event.key) {
            case 'ArrowLeft':
                this.isRotatingLeft = true;
                break;
            case 'ArrowRight':
                this.isRotatingRight = true;
                break;
        }
    }

    onKeyUp(event) {
        if (!this.renderer.xr.isPresenting) return; // Only active in VR

        switch (event.key) {
            case 'ArrowLeft':
                this.isRotatingLeft = false;
                break;
            case 'ArrowRight':
                this.isRotatingRight = false;
                break;
        }
    }

    // New method to toggle wireframe mode
    setWireframeMode(enabled) {
        if (!this.material) return;

        if (enabled) {
            this.material.wireframe = true;
            this.material.map = null; // Remove texture when in wireframe mode
            this.material.color.set(0x00ff00); // Set a green color for the wireframe
            this.material.needsUpdate = true;
        } else {
            this.material.wireframe = false;
            // When disabling wireframe, re-load the panorama to restore the texture
            // The loadPanorama function already handles setting map and needsUpdate
            this.loadPanorama(); 
            this.material.color.set(0xffffff); // Reset color to white for texture
            this.material.needsUpdate = true;
        }
        this.render(); // Render the change immediately
    }
}
