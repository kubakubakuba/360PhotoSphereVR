import * as THREE from 'three';
import { VRGallery } from './vr/gallery.js';
import { VRGlobePanel } from './vr/globe-panel.js';
import { itemCoordinates } from './vr/geo.js';
import { LoadingRing } from './vr/loading-ring.js';
import { Animator, PhotoSphere, DIM_OPACITY, R_ORB, easeOutCubic } from './vr/transitions.js';
import { TextLabel } from './vr/text-label.js';
import { EquirectLayer } from './vr/equirect-layer.js';
import { fetchBlob, prefetch, decodePanorama, createPanoramaTexture, streamToTexture } from './vr/image-source.js';

const ACCENT = '#43cea2';
const ORB_OFFSET = new THREE.Vector3(0, 0.06, -1.1); // relative to the head, in the follow rig
const PANEL_OFFSET = new THREE.Vector3(0, -0.33, -1.25);
const HUD_OFFSET = new THREE.Vector3(0, -0.5, -0.45);
const FOLLOW_ANGLE = THREE.MathUtils.degToRad(35);
const HUD_FOLLOW_ANGLE = THREE.MathUtils.degToRad(50);
const MAX_FRAMEBUFFER_SCALE = 1.5;
const HINT_STORAGE_KEY = 'pano-vr-controls-hint-shown';
const HINT_DURATION = 5; // seconds the controls hint stays fully visible
// Default panorama size cap: ~the Quest 3 display density over 360° (about 25 px/deg).
// Larger textures cost memory without looking sharper.
const DEFAULT_MAX_TEXTURE_SIZE = 8192;
const LAYER_HANDOFF_FRAMES = 10; // frames the mesh stays visible after the layer is drawn
const AXIS_ON = 0.7;
const AXIS_OFF = 0.3;
const MENU_BUTTON = 5; // B / Y on xr-standard (Quest Touch) controllers

function wrapAngle(angle) {
	return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function createEnvironment(floorY) {
	const group = new THREE.Group();
	const sky = new THREE.Mesh(
		new THREE.SphereGeometry(80, 32, 16),
		new THREE.ShaderMaterial({
			side: THREE.BackSide,
			depthWrite: false,
			uniforms: {
				top: { value: new THREE.Color(0x1b2430) },
				bottom: { value: new THREE.Color(0x050608) },
			},
			vertexShader: /* glsl */ `
				varying vec3 vDirection;
				void main() {
					vDirection = normalize(position);
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}`,
			fragmentShader: /* glsl */ `
				uniform vec3 top;
				uniform vec3 bottom;
				varying vec3 vDirection;
				void main() {
					gl_FragColor = vec4(mix(bottom, top, smoothstep(-0.25, 0.6, vDirection.y)), 1.0);
					#include <colorspace_fragment>
				}`,
		}),
	);
	sky.renderOrder = -2;
	const grid = new THREE.GridHelper(40, 40, 0x43cea2, 0x2a3440);
	grid.material.transparent = true;
	grid.material.opacity = 0.18;
	grid.material.depthWrite = false;
	grid.position.y = floorY;
	group.add(sky, grid);
	return group;
}

function createHudButton() {
	const canvas = document.createElement('canvas');
	canvas.width = 384;
	canvas.height = 128;
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = 'rgba(18, 20, 24, 0.85)';
	ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
	ctx.lineWidth = 4;
	ctx.beginPath();
	ctx.roundRect(2, 2, 380, 124, 62);
	ctx.fill();
	ctx.stroke();
	ctx.fillStyle = ACCENT;
	for (let i = 0; i < 4; i++) ctx.fillRect(58 + (i % 2) * 22, 40 + Math.floor(i / 2) * 22, 16, 16);
	ctx.fillStyle = '#e8eaed';
	ctx.font = '600 46px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
	ctx.textBaseline = 'middle';
	ctx.fillText('Gallery', 126, 66);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	const mesh = new THREE.Mesh(
		new THREE.PlaneGeometry(0.15, 0.05),
		new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, depthWrite: false }),
	);
	mesh.visible = false;
	return mesh;
}

export class Viewer {
	constructor({ containerId, panorama, items = [], config = {}, resolveUrl = (path) => path }) {
		this.container = document.getElementById(containerId);
		this.resolveUrl = resolveUrl; // maps gallery paths (e.g. local:<id>) to fetchable URLs
		this.config = config;
		this.items = items;
		this.current = panorama;

		this.busy = false;
		this.queuedAction = null; // press made during a transition, see runWhenIdle()
		this.destroyed = false;
		this.frameCount = 0;
		this.lastTime = 0;
		this.renderErrors = 0;
		this.layer = null;
		this.layerFrames = 0;
		this.frameWaiters = [];

		this.head ={ position: new THREE.Vector3(0, 1.6, 0), direction: new THREE.Vector3(0, 0, -1), yaw: 0 };
		this.anchorWorld = new THREE.Vector3();
		this.eyeLeft = new THREE.Vector3();
		this.eyeRight = new THREE.Vector3();
		this.hudYaw = 0;
		this.hudAlpha = 0;
		this.rigFollowing = false;

		this.boundOnKeyDown = this.onKeyDown.bind(this);
		this.boundOnResize = this.onResize.bind(this);

		this.init();
	}

	init() {
		const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		renderer.setPixelRatio(window.devicePixelRatio);
		renderer.setSize(this.container.clientWidth || 1, this.container.clientHeight || 1);
		renderer.setClearColor(0x000000, 0);
		renderer.xr.enabled = true;
		this.renderer = renderer;
		this.container.replaceChildren(renderer.domElement);

		this.scene = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(70, (this.container.clientWidth || 1) / (this.container.clientHeight || 1), 0.01, 500);
		this.animator = new Animator();

		this.sphere = new PhotoSphere();
		this.scene.add(this.sphere.mesh);

		this.dim = new THREE.Mesh(
			new THREE.SphereGeometry(20, 32, 16),
			new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false }),
		);
		this.dim.renderOrder = -1;
		this.dim.visible = false;
		this.scene.add(this.dim);

		// Everything that floats in front of the user lives in this rig and lazily follows their gaze.
		this.rig = new THREE.Group();
		this.orbAnchor = new THREE.Object3D();
		this.orbAnchor.position.copy(ORB_OFFSET);
		this.rig.add(this.orbAnchor);
		this.loadingRing = new LoadingRing({ color: ACCENT });
		this.orbAnchor.add(this.loadingRing);
		this.nameLabel = new TextLabel({ height: 0.04, maxWidth: 0.45 });
		this.nameLabel.position.set(0, R_ORB + 0.05, 0);
		this.orbAnchor.add(this.nameLabel);

		this.hasGlobe = this.config.globe !== false && this.items.some((item) => itemCoordinates(item));
		this.gallery = new VRGallery({
			items: this.items,
			accent: ACCENT,
			onSelect: (path) => this.selectPanorama(path),
			onExit: () => this.requestExitVR(),
			onGlobe: this.hasGlobe ? () => this.runWhenIdle('globe', () => this.openGlobe()) : undefined,
		});
		this.globePanel = new VRGlobePanel({
			items: this.items,
			accent: ACCENT,
			config: this.config,
			resolveUrl: this.resolveUrl,
			onSelect: (path) => this.selectFromGlobe(path),
			onBack: () => this.runWhenIdle('toggle', () => this.closeGlobe()),
		});
		this.setCurrentPhoto(this.current);
		this.gallery.panel.position.copy(PANEL_OFFSET);
		this.gallery.panel.rotation.x = -Math.atan2(-PANEL_OFFSET.y, -PANEL_OFFSET.z);
		this.rig.add(this.gallery.panel, this.globePanel.panel);
		this.scene.add(this.rig);

		this.hud = createHudButton();
		this.hud.userData = { hover: 0, onActivate: () => this.openGallery() };
		this.scene.add(this.hud);

		this.hint = new TextLabel({ height: 0.035, maxWidth: 1.2, fontSize: 36 });
		this.hintAge = null; // seconds since the controls hint appeared, null when not shown
		this.scene.add(this.hint);

		this.setupPointers();
		window.addEventListener('keydown', this.boundOnKeyDown);
		window.addEventListener('resize', this.boundOnResize);
	}

	setupPointers() {
		this.raycaster = new THREE.Raycaster();
		const rayGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
		const cursorGeometry = new THREE.RingGeometry(0.004, 0.007, 24);

		this.pointers = [0, 1].map((index) => {
			const controller = this.renderer.xr.getController(index);
			const ray = new THREE.Line(rayGeometry, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
			ray.visible = false;
			controller.add(ray);

			const cursor = new THREE.Mesh(cursorGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false }));
			cursor.renderOrder = 10;
			cursor.visible = false;
			this.scene.add(controller, cursor);

			// drag: the object a held trigger / pinch is dragging (the globe)
			const pointer = { controller, ray, cursor, source: null, hovered: null, drag: null, menuDown: false, axisDirection: 0 };
			pointer.listeners = {
				connected: (event) => { pointer.source = event.data; },
				disconnected: () => {
					this.onSelectEnd(pointer);
					this.setHover(pointer, null);
					pointer.source = null;
				},
				selectstart: () => this.onSelect(pointer),
				selectend: () => this.onSelectEnd(pointer),
				squeezestart: () => this.toggleGallery(),
			};
			for (const [type, listener] of Object.entries(pointer.listeners)) controller.addEventListener(type, listener);
			return pointer;
		});
	}

	// --- Session ---------------------------------------------------------

	async startSession(session, { mode = 'immersive-vr' } = {}) {
		const xr = this.renderer.xr;
		const config = this.config;
		this.mode = mode;

		xr.setFoveation(THREE.MathUtils.clamp(Number(config.vrFoveation) || 0, 0, 1));
		xr.setFramebufferScaleFactor(this.pickFramebufferScale(session));
		const referenceSpaceType = await this.pickReferenceSpace(session);
		xr.setReferenceSpaceType(referenceSpaceType);
		await xr.setSession(session);
		if (this.destroyed) return;

		const baseLayer = xr.getBaseLayer();
		if (baseLayer && 'blendTextureSourceAlpha' in baseLayer) baseLayer.blendTextureSourceAlpha = true;

		if (config.vrUseLayers !== false && EquirectLayer.isSupported(this.renderer)) {
			this.layer = new EquirectLayer(this.renderer);
		}

		if (mode !== 'immersive-ar') {
			this.environment = createEnvironment(referenceSpaceType === 'local-floor' ? 0 : -1.6);
			this.environment.visible = false;
			this.scene.add(this.environment);
		}

		console.log(`VR session: mode=${mode}, referenceSpace=${referenceSpaceType}, equirectLayer=${!!this.layer}, `
			+ `foveation=${xr.getFoveation()}, maxTexture=${this.renderer.capabilities.maxTextureSize}`);

		// Start as an empty orb: the first photo arrives through the loading transition.
		this.sphere.k = 1;
		this.sphere.orbScale = 0;
		this.dim.material.opacity = DIM_OPACITY;
		this.renderer.setAnimationLoop((time, frame) => this.loop(time, frame));
	}

	pickFramebufferScale(session) {
		const configured = Number(this.config.vrFramebufferScale);
		if (configured > 0) return configured;
		const native = window.XRWebGLLayer?.getNativeFramebufferScaleFactor?.(session) || 1;
		return Math.min(native, MAX_FRAMEBUFFER_SCALE);
	}

	async pickReferenceSpace(session) {
		for (const type of ['local-floor', 'local', 'viewer']) {
			try {
				await session.requestReferenceSpace(type);
				return type;
			} catch (error) {
				console.warn(`Reference space "${type}" not available`);
			}
		}
		throw new Error('No supported XR reference space');
	}

	requestExitVR() {
		this.container.dispatchEvent(new CustomEvent('exitvrrequest', { bubbles: true }));
	}

	// --- Frame loop ------------------------------------------------------

	loop(time, frame) {
		// The loop is set after the session started, so three.js also runs it from the window's
		// requestAnimationFrame (no XR frame, stale head pose, another clock): only XR frames count.
		if (this.destroyed || !frame) return;
		const dt = this.lastTime ? THREE.MathUtils.clamp((time - this.lastTime) / 1000, 0, 0.1) : 0;
		this.lastTime = time;
		this.frameCount++;

		try {
			this.updateHead();
			// The head pose becomes valid after the first rendered frames.
			if (this.frameCount === 4) this.startIntro();

			this.animator.tick(time);
			this.pollGamepads(dt);
			this.followRig(dt);
			this.gallery.update(dt);
			this.globePanel.update(dt, this.head.position);
			this.updateHud(dt);
			this.updatePointers();
			this.updateScene(dt);
			this.loadingRing.update(dt);
			this.updateHint(dt);
			this.layer?.update(frame);

			this.renderer.render(this.scene, this.camera);
			this.renderErrors = 0;
		} catch (error) {
			console.error('Error in VR frame:', error);
			if (++this.renderErrors > 30) this.requestExitVR();
		}
		this.resolveFrameWaiters();
	}

	// Lets streamed uploads do one chunk of work per frame.
	resolveFrameWaiters() {
		const waiters = this.frameWaiters;
		this.frameWaiters = [];
		waiters.forEach((resolve) => resolve());
	}

	updateHead() {
		const camera = this.renderer.xr.getCamera();
		// Until it renders, the XR camera holds the first eye's pose: use the point between the eyes.
		const [left, right] = camera.cameras;
		if (left && right) this.head.position.copy(left.getWorldPosition(this.eyeLeft)).lerp(right.getWorldPosition(this.eyeRight), 0.5);
		else camera.getWorldPosition(this.head.position);
		camera.getWorldDirection(this.head.direction);
		this.head.yaw = Math.atan2(-this.head.direction.x, -this.head.direction.z);
	}

	placeRig() {
		this.rig.position.copy(this.head.position);
		this.rig.rotation.set(0, this.head.yaw, 0);
		this.rigFollowing = false;
	}

	followRig(dt) {
		if (this.sphere.k <= 0 && !this.gallery.visible && !this.globePanel.visible) return;
		const difference = wrapAngle(this.head.yaw - this.rig.rotation.y);
		if (Math.abs(difference) > FOLLOW_ANGLE) this.rigFollowing = true;
		if (this.rigFollowing) {
			this.rig.rotation.y += difference * (1 - Math.exp(-dt * 5));
			if (Math.abs(difference) < 0.02) this.rigFollowing = false;
		}
		this.rig.position.lerp(this.head.position, 1 - Math.exp(-dt * 3));
	}

	updateScene(dt) {
		const sphere = this.sphere;
		this.rig.updateMatrixWorld();
		this.orbAnchor.getWorldPosition(this.anchorWorld);

		if (this.layer?.failed) {
			console.warn('Disabling equirect layer');
			this.layer.setVisible(false);
			this.layer.dispose();
			this.layer = null;
		}

		// Once the compositor layer shows the photo, stop drawing the mesh copy (with some margin,
		// as the compositor may pick the layer up a few frames late).
		if (this.layer?.ready && sphere.k <= 0) this.layerFrames++;
		else this.layerFrames = 0;
		sphere.hidden = this.layerFrames > LAYER_HANDOFF_FRAMES;
		sphere.update(this.head.position, this.anchorWorld, dt);

		const dimOpacity = this.dim.material.opacity;
		this.dim.visible = dimOpacity > 0.001;
		this.dim.position.copy(this.head.position);
		if (this.environment) this.environment.visible = sphere.k > 0.001;
		// Photo name above the orb while the gallery is open (hidden while it shrinks into the ring).
		this.nameLabel.setOpacity(sphere.k >= 1 ? this.gallery.alpha * Math.min(1, sphere.orbScale) : 0);
	}

	// --- Input -----------------------------------------------------------

	pollGamepads(dt) {
		for (const pointer of this.pointers) {
			const gamepad = pointer.source?.gamepad;
			if (!gamepad) continue;

			const menuDown = !!gamepad.buttons[MENU_BUTTON]?.pressed;
			if (menuDown && !pointer.menuDown) this.toggleGallery();
			pointer.menuDown = menuDown;

			const x = gamepad.axes[2] ?? 0;
			if (this.globePanel.visible) {
				// Held, not flicked: turns and zooms the globe.
				this.globePanel.stick(x, gamepad.axes[3] ?? 0, dt);
				pointer.axisDirection = Math.abs(x) > AXIS_OFF ? Math.sign(x) : 0;
				continue;
			}
			if (Math.abs(x) < AXIS_OFF) {
				pointer.axisDirection = 0;
			} else if (Math.abs(x) > AXIS_ON && pointer.axisDirection === 0) {
				pointer.axisDirection = Math.sign(x);
				this.onStick(pointer, pointer.axisDirection);
			}
		}
	}

	onStick(pointer, direction) {
		this.dismissHint();
		if (this.globePanel.visible) return;
		if (this.gallery.visible) {
			if (this.gallery.changePage(direction)) this.pulse(pointer, 0.3, 25);
		} else {
			this.stepPanorama(direction);
		}
	}

	getInteractives() {
		const targets = [...this.gallery.getInteractives(), ...this.globePanel.getInteractives()];
		if (this.hud.visible && this.hudAlpha > 0.6) targets.push(this.hud);
		return targets;
	}

	updatePointers() {
		const targets = this.getInteractives();
		for (const pointer of this.pointers) {
			if (!pointer.source || targets.length === 0) {
				this.setHover(pointer, null);
				pointer.ray.visible = false;
				pointer.cursor.visible = false;
				continue;
			}

			pointer.controller.updateMatrixWorld();
			this.raycaster.setFromXRController(pointer.controller);
			if (pointer.drag) pointer.drag.userData.onDrag?.(this.raycaster.ray);
			const hit = this.raycaster.intersectObjects(targets, false)[0];
			this.setHover(pointer, pointer.drag ?? (hit ? hit.object : null));

			pointer.ray.visible = true;
			pointer.ray.scale.z = hit ? hit.distance : 1.5;
			pointer.cursor.visible = !!hit;
			if (hit) {
				pointer.cursor.position.copy(hit.point);
				pointer.cursor.lookAt(this.head.position);
			}
		}
	}

	setHover(pointer, object) {
		if (pointer.hovered === object) return;
		if (pointer.hovered) pointer.hovered.userData.hover--;
		pointer.hovered = object;
		if (object) {
			object.userData.hover++;
			this.pulse(pointer, 0.25, 18);
		}
	}

	onSelect(pointer) {
		this.dismissHint();
		const target = pointer.hovered;
		if (!target) return;
		if (target.userData.onPress) {
			// Press-and-hold targets (the globe surface) follow the ray until released.
			pointer.controller.updateMatrixWorld();
			this.raycaster.setFromXRController(pointer.controller);
			if (target.userData.onPress(this.raycaster.ray)) {
				pointer.drag = target;
				this.pulse(pointer, 0.3, 20);
			}
			return;
		}
		this.pulse(pointer, 0.6, 40);
		target.userData.onActivate?.();
	}

	onSelectEnd(pointer) {
		if (!pointer.drag) return;
		pointer.drag.userData.onRelease?.();
		pointer.drag = null;
	}

	pulse(pointer, intensity, duration) {
		const actuator = pointer?.source?.gamepad?.hapticActuators?.[0];
		if (actuator?.pulse) {
			actuator.pulse(intensity, duration).catch?.(() => {});
		}
	}

	onKeyDown(event) {
		if (event.repeat) return;
		if (event.code === 'KeyG') this.toggleGallery();
		else if (event.code === 'KeyM' && this.hasGlobe) this.runWhenIdle('globe', () => (this.globePanel.visible ? this.closeGlobe() : this.openGlobe()));
		else if (event.code === 'ArrowLeft') this.onStick(null, -1);
		else if (event.code === 'ArrowRight') this.onStick(null, 1);
	}

	onResize() {
		if (this.renderer.xr.isPresenting) return;
		const width = this.container.clientWidth || 1;
		const height = this.container.clientHeight || 1;
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(width, height);
	}

	// Small "Gallery" button at chest height, for hand tracking (no B/Y button).
	updateHud(dt) {
		const handsActive = this.pointers.some((pointer) => pointer.source?.hand);
		const show = handsActive && this.sphere.k <= 0 && !this.busy && !this.gallery.visible;
		this.hudAlpha += ((show ? 1 : 0) - this.hudAlpha) * (1 - Math.exp(-dt * 10));
		this.hud.visible = this.hudAlpha > 0.01;
		if (!this.hud.visible) {
			this.hudYaw = this.head.yaw;
			return;
		}

		if (Math.abs(wrapAngle(this.head.yaw - this.hudYaw)) > HUD_FOLLOW_ANGLE) this.hudFollowing = true;
		if (this.hudFollowing) {
			const difference = wrapAngle(this.head.yaw - this.hudYaw);
			this.hudYaw += difference * (1 - Math.exp(-dt * 4));
			if (Math.abs(difference) < 0.05) this.hudFollowing = false;
		}
		this.hud.position.copy(HUD_OFFSET).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.hudYaw).add(this.head.position);
		this.hud.lookAt(this.head.position);
		this.hud.material.opacity = this.hudAlpha * (this.hud.userData.hover > 0 ? 1 : 0.8);
	}

	// --- Transitions -----------------------------------------------------

	startIntro() {
		this.placeRig();
		this.showPanorama(this.current).then(() => this.maybeShowHint());
	}

	setCurrentPhoto(path) {
		this.current = path;
		this.gallery.setCurrent(path);
		this.globePanel.setCurrent(path);
		const item = this.items.find((entry) => entry.path === path);
		this.nameLabel.setText(item?.name || (path ? decodeURIComponent(path.split('/').pop()) : ''));
	}

	// One-time controls hint after the first photo has expanded (remembered per browser).
	maybeShowHint() {
		if (this.destroyed || this.hintShown) return;
		this.hintShown = true;
		try {
			if (localStorage.getItem(HINT_STORAGE_KEY)) return;
			localStorage.setItem(HINT_STORAGE_KEY, '1');
		} catch { /* no storage: show it this session */ }

		const separator = { text: '   ·   ', style: 'muted' };
		this.hint.setParts(this.handsOnly()
			? [{ text: 'Pinch', style: 'accent' }, ' the Gallery button below you to browse photos']
			: [
				{ text: 'B / Y', style: 'accent' }, '  Gallery', separator,
				{ text: 'Stick ◀ ▶', style: 'accent' }, '  Next photo', separator,
				{ text: 'Trigger', style: 'accent' }, '  Select',
			]);

		const forward = new THREE.Vector3(-Math.sin(this.head.yaw), 0, -Math.cos(this.head.yaw));
		this.hint.position.copy(this.head.position).addScaledVector(forward, 1).add(new THREE.Vector3(0, -0.25, 0));
		this.hint.lookAt(this.head.position);
		this.hintAge = 0;
	}

	handsOnly() {
		return this.pointers.some((p) => p.source?.hand) && !this.pointers.some((p) => p.source?.gamepad && !p.source.hand);
	}

	updateHint(dt) {
		if (this.hintAge === null) return;
		this.hintAge += dt;
		const fadeIn = Math.min(1, this.hintAge / 0.3);
		const fadeOut = 1 - Math.max(0, (this.hintAge - 0.3 - HINT_DURATION) / 0.5);
		this.hint.setOpacity(Math.max(0, Math.min(fadeIn, fadeOut)));
		if (fadeOut <= 0) this.hintAge = null;
	}

	dismissHint() {
		if (this.hintAge !== null) this.hintAge = Math.max(this.hintAge, 0.3 + HINT_DURATION);
	}

	async collapse() {
		const sphere = this.sphere;
		if (sphere.k >= 1) return;
		if (sphere.k <= 0) this.placeRig();
		sphere.hidden = false;
		this.layerFrames = 0;
		this.layer?.setVisible(false);

		const k0 = sphere.k;
		const dim0 = this.dim.material.opacity;
		await this.animator.tween({
			duration: 650,
			update: (p) => {
				sphere.k = k0 + (1 - k0) * p;
				this.dim.material.opacity = dim0 + (DIM_OPACITY - dim0) * p;
			},
		});
	}

	async expand() {
		const sphere = this.sphere;
		if (!sphere.hasTexture) return;
		const k0 = sphere.k;
		const dim0 = this.dim.material.opacity;
		sphere.prepareExpand();
		await this.animator.tween({
			duration: 750,
			update: (p) => {
				sphere.k = k0 * (1 - p);
				sphere.unwind(p);
				this.dim.material.opacity = dim0 * (1 - p);
			},
		});
		if (!this.destroyed) this.layer?.setVisible(true);
	}

	nextFrame() {
		if (this.destroyed) return Promise.resolve();
		return new Promise((resolve) => this.frameWaiters.push(resolve));
	}

	// Download (0-70 %), decode (off-thread), then stream into the GPU strip by strip (75-100 %).
	// GPU memory is only allocated once `gpuReady` resolves, i.e. after the previous photo was released.
	async loadPanorama(path, gpuReady = Promise.resolve()) {
		const ring = this.loadingRing;
		ring.setProgress(-1);
		const blob = await fetchBlob(this.resolveUrl(path), (progress) => ring.setProgress(progress * 0.7));
		const gpuLimit = this.renderer.capabilities.maxTextureSize;
		const configured = Number(this.config.vrMaxTextureSize) || 0;
		const maxSize = Math.min(configured > 0 ? configured : DEFAULT_MAX_TEXTURE_SIZE, gpuLimit);

		const bitmap = await decodePanorama(blob, { maxSize });
		await gpuReady;
		if (this.destroyed) {
			bitmap.close();
			throw new Error('Viewer destroyed');
		}
		ring.setProgress(0.75);

		const texture = createPanoramaTexture(bitmap.width, bitmap.height, this.renderer);
		try {
			await streamToTexture(bitmap, texture, this.renderer, {
				nextFrame: () => this.nextFrame(),
				isCancelled: () => this.destroyed,
				onProgress: (progress) => ring.setProgress(0.75 + progress * 0.25),
			});
		} catch (error) {
			texture.dispose();
			throw error;
		} finally {
			bitmap.close();
		}
		return texture;
	}

	async showPanorama(path) {
		if (this.busy || this.destroyed || !path) return;
		this.busy = true;
		const sphere = this.sphere;
		const ring = this.loadingRing;

		let releaseGpu;
		const gpuReady = new Promise((resolve) => { releaseGpu = resolve; });

		try {
			const loading = this.loadPanorama(path, gpuReady);
			loading.catch(() => {}); // handled below, after the collapse animation

			await this.collapse();

			// The orb shrinks into the loading ring...
			ring.setError(false);
			const orb0 = sphere.orbScale;
			await this.animator.tween({
				duration: 420,
				update: (p) => {
					sphere.orbScale = orb0 * (1 - p);
					ring.setEnter(p);
				},
			});

			// The old photo is out of sight now: free its texture and layer before the new one
			// is allocated, so two full-size photos never sit in GPU memory at the same time.
			this.releasePhoto();
			releaseGpu();

			let texture;
			try {
				[texture] = await Promise.all([loading, this.animator.wait(400)]);
			} catch (error) {
				if (!this.destroyed) await this.recoverFromLoadError(path, error);
				return;
			}
			if (this.destroyed) {
				texture.dispose();
				return;
			}
			await this.animator.wait(180); // let the completed ring flash

			sphere.setTexture(texture);
			if (this.layer) {
				try {
					this.layer.setImage(texture);
				} catch (error) {
					console.warn('Could not create equirect layer, using sphere mesh:', error);
					this.layer.failed = true;
				}
			}

			this.setCurrentPhoto(path);
			this.container.dispatchEvent(new CustomEvent('panoramachange', { bubbles: true, detail: { path } }));

			// ...and the new orb grows out of it.
			await this.animator.tween({
				duration: 480,
				ease: easeOutCubic,
				update: (p) => {
					sphere.orbScale = p;
					ring.setLeave(p);
				},
			});

			if (!this.gallery.visible) await this.expand();
			this.prefetchNeighbours();
		} catch (error) {
			console.error('Error while switching panorama:', error);
		} finally {
			releaseGpu();
			this.endBusy();
		}
	}

	releasePhoto() {
		this.sphere.setTexture(null);
		this.layer?.setVisible(false);
		this.layer?.retire();
	}

	async recoverFromLoadError(path, error) {
		console.error(`Could not load panorama ${path}:`, error);
		this.loadingRing.setError(true);
		await this.animator.wait(1200);
		await this.animator.tween({
			duration: 400,
			update: (p) => {
				this.loadingRing.setLeave(p);
			},
		});
		this.loadingRing.setError(false);
		// The previous photo was released before loading, so let the user pick again
		// (choosing the same photo reloads it).
		if (!this.gallery.visible) this.gallery.show();
	}

	prefetchNeighbours() {
		const count = this.items.length;
		const index = this.items.findIndex((item) => item.path === this.current);
		if (count < 2 || index < 0) return;
		for (const neighbour of [this.items[(index + 1) % count], this.items[(index - 1 + count) % count]]) {
			if (!neighbour.local) prefetch(this.resolveUrl(neighbour.path)); // local photos are already in memory
		}
	}

	// Transitions can't be interrupted, so presses made meanwhile are queued instead of dropped.
	// The latest press wins; a second gallery toggle cancels a queued one.
	runWhenIdle(kind, action) {
		if (!this.busy) {
			action();
			return;
		}
		this.queuedAction = kind === 'toggle' && this.queuedAction?.kind === 'toggle' ? null : { kind, action };
	}

	endBusy() {
		this.busy = false;
		const queued = this.queuedAction;
		this.queuedAction = null;
		if (queued && !this.destroyed) queueMicrotask(queued.action);
	}

	toggleGallery() {
		this.dismissHint();
		this.runWhenIdle('toggle', () => {
			if (this.globePanel.visible) this.closeGlobe();
			else if (this.gallery.visible) this.closeGallery();
			else this.openGallery();
		});
	}

	async openGallery() {
		if (this.busy || this.gallery.visible || this.destroyed) return;
		this.busy = true;
		try {
			if (this.sphere.k <= 0) this.placeRig();
			this.gallery.show();
			await this.collapse();
		} finally {
			this.endBusy();
		}
	}

	async closeGallery() {
		if (this.busy || !this.gallery.visible || !this.sphere.hasTexture) return;
		this.busy = true;
		try {
			this.gallery.hide();
			await this.expand();
		} finally {
			this.endBusy();
		}
	}

	// The globe takes the photo orb's place; the orb shrinks away while it is open.
	async openGlobe() {
		if (this.busy || this.globePanel.visible || this.destroyed) return;
		this.busy = true;
		try {
			if (this.sphere.k <= 0) this.placeRig();
			this.gallery.hide();
			this.globePanel.show(this.current, { handsOnly: this.handsOnly() });
			await this.collapse();
			await this.tweenOrbScale(0);
		} finally {
			this.endBusy();
		}
	}

	// Back to the gallery.
	async closeGlobe() {
		if (this.busy || !this.globePanel.visible) return;
		this.busy = true;
		try {
			this.globePanel.hide();
			this.gallery.show();
			if (this.sphere.hasTexture) await this.tweenOrbScale(1);
		} finally {
			this.endBusy();
		}
	}

	async tweenOrbScale(target, duration = 300) {
		const from = this.sphere.orbScale;
		if (from === target) return;
		await this.animator.tween({
			duration,
			update: (p) => { this.sphere.orbScale = from + (target - from) * p; },
		});
	}

	selectFromGlobe(path) {
		this.runWhenIdle('select', () => {
			this.globePanel.hide();
			if (path === this.current && this.sphere.hasTexture) this.returnToPhoto();
			else this.showPanorama(path);
		});
	}

	async returnToPhoto() {
		if (this.busy) return;
		this.busy = true;
		try {
			await this.tweenOrbScale(1);
			await this.expand();
		} finally {
			this.endBusy();
		}
	}

	selectPanorama(path) {
		this.runWhenIdle('select', () => {
			if (path === this.current && this.sphere.hasTexture) {
				this.closeGallery();
				return;
			}
			this.gallery.hide();
			this.showPanorama(path);
		});
	}

	stepPanorama(direction) {
		this.runWhenIdle('step', () => {
			const count = this.items.length;
			if (count === 0) return;
			const index = this.items.findIndex((item) => item.path === this.current);
			const next = index < 0
				? this.items[direction > 0 ? 0 : count - 1]
				: this.items[(index + direction + count) % count];
			if (next.path !== this.current) this.showPanorama(next.path);
		});
	}

	// --- Teardown --------------------------------------------------------

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		console.log('Destroying VR viewer');

		window.removeEventListener('keydown', this.boundOnKeyDown);
		window.removeEventListener('resize', this.boundOnResize);
		this.animator.clear();
		this.resolveFrameWaiters(); // pending uploads see `destroyed` and bail out

		const renderer = this.renderer;
		renderer.setAnimationLoop(null);

		for (const pointer of this.pointers) {
			for (const [type, listener] of Object.entries(pointer.listeners)) pointer.controller.removeEventListener(type, listener);
		}

		this.layer?.dispose();
		this.layer = null;
		this.sphere.dispose();
		this.gallery.dispose();
		this.globePanel.dispose();
		this.loadingRing.dispose();
		this.scene.traverse((object) => {
			object.geometry?.dispose();
			if (object.material) {
				object.material.map?.dispose();
				object.material.dispose();
			}
		});
		this.scene.clear();

		renderer.dispose();
		renderer.forceContextLoss();
		renderer.domElement.remove();
	}
}

export default Viewer;
