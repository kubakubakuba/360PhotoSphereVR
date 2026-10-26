import * as THREE from 'three';
import { R_ORB } from './transitions.js';

const TAU = Math.PI * 2;
const SEGMENTS = 128;
const INDETERMINATE_ARC = 0.22; // fraction of the circle shown while progress is unknown

function makeGlowTexture() {
	const size = 256;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	const center = size / 2;
	// A soft band at ~71 % of the half-size, matching GLOW_SCALE below.
	const gradient = ctx.createRadialGradient(center, center, center * 0.52, center, center, center * 0.9);
	gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
	gradient.addColorStop(0.5, 'rgba(255, 255, 255, 1)');
	gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, size, size);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

const GLOW_SCALE = 2.8; // glow plane size relative to the ring radius

/**
 * Loading indicator the photo orb collapses into: a glowing ring that fills
 * with progress, then widens and fades as the next orb grows out of it.
 */
export class LoadingRing extends THREE.Group {
	constructor({ radius = 0.13, color = 0x43cea2, errorColor = 0xf2555a } = {}) {
		super();
		this.radius = radius;
		this.color = new THREE.Color(color);
		this.errorColor = new THREE.Color(errorColor);
		this.progress = 0;
		this.indeterminate = true;
		this.spin = 0;
		this.time = 0;
		this.flash = 0;
		this.opacity = 0;
		this.visible = false;

		const overlay = { transparent: true, depthWrite: false, depthTest: false };
		const additive = { ...overlay, blending: THREE.AdditiveBlending };

		this.track = new THREE.Mesh(
			new THREE.RingGeometry(radius - 0.0015, radius + 0.0015, SEGMENTS),
			new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.18, ...overlay }),
		);

		this.arcMaterial = new THREE.MeshBasicMaterial({ color: this.color, side: THREE.DoubleSide, ...overlay });
		this.arc = new THREE.Mesh(this.makeArc(INDETERMINATE_ARC), this.arcMaterial);

		this.headMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, ...additive });
		this.head = new THREE.Mesh(new THREE.CircleGeometry(0.0055, 24), this.headMaterial);

		this.glowMaterial = new THREE.MeshBasicMaterial({ map: makeGlowTexture(), color: this.color, ...additive });
		this.glow = new THREE.Mesh(new THREE.PlaneGeometry(radius * GLOW_SCALE, radius * GLOW_SCALE), this.glowMaterial);

		this.add(this.glow, this.track, this.arc, this.head);
		this.traverse((object) => { object.renderOrder = 5; });
		this.applyOpacity();
	}

	makeArc(fraction) {
		const length = Math.max(fraction, 0.001) * TAU;
		return new THREE.RingGeometry(this.radius - 0.0035, this.radius + 0.0035, SEGMENTS, 1, Math.PI / 2 - length, length);
	}

	// progress in [0, 1], or a negative value for "unknown"
	setProgress(progress) {
		const wasComplete = this.progress >= 1 && !this.indeterminate;
		this.indeterminate = progress < 0;
		this.progress = this.indeterminate ? 0 : Math.min(progress, 1);
		this.arc.geometry.dispose();
		this.arc.geometry = this.makeArc(this.indeterminate ? INDETERMINATE_ARC : this.progress);
		if (!this.indeterminate) this.spin = 0;
		if (this.progress >= 1 && !wasComplete) this.flash = 1;
	}

	setError(isError) {
		const color = isError ? this.errorColor : this.color;
		this.arcMaterial.color.copy(color);
		this.glowMaterial.color.copy(color);
		if (isError) this.setProgress(1);
	}

	// p 0 → 1: born at the orb's silhouette, tightening as the orb shrinks inside it.
	setEnter(p) {
		this.opacity = p;
		this.scale.setScalar(THREE.MathUtils.lerp(R_ORB / this.radius, 1, p));
		this.visible = p > 0.001;
		this.applyOpacity();
	}

	// p 0 → 1: widens and fades while the next orb grows out of it.
	setLeave(p) {
		this.opacity = 1 - p;
		this.scale.setScalar(THREE.MathUtils.lerp(1, 1.6, p));
		this.visible = p < 0.999;
		this.applyOpacity();
	}

	applyOpacity() {
		const pulse = 0.5 + 0.5 * Math.sin(this.time * 3);
		this.track.material.opacity = 0.18 * this.opacity;
		this.arcMaterial.opacity = this.opacity;
		this.headMaterial.opacity = this.opacity * (this.indeterminate || this.progress < 1 ? 0.9 : 0);
		this.glowMaterial.opacity = this.opacity * (0.28 + 0.12 * pulse + 0.6 * this.flash);
	}

	update(dt) {
		if (!this.visible) return;
		this.time += dt;
		this.flash = Math.max(0, this.flash - dt * 2.5);

		if (this.indeterminate) this.spin -= dt * 4;
		this.arc.rotation.z = this.spin;

		// Bright dot riding the leading edge of the arc.
		const fraction = this.indeterminate ? INDETERMINATE_ARC : this.progress;
		const angle = Math.PI / 2 - fraction * TAU + this.spin;
		this.head.position.set(Math.cos(angle) * this.radius, Math.sin(angle) * this.radius, 0.001);

		this.applyOpacity();
	}

	dispose() {
		this.traverse((object) => {
			object.geometry?.dispose();
			if (object.material) {
				object.material.map?.dispose();
				object.material.dispose();
			}
		});
	}
}
