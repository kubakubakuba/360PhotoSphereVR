import * as THREE from 'three';

export const R_IMMERSED = 30; // radius of the sphere surrounding the viewer
export const R_ORB = 0.17; // radius of the floating photo orb
export const DIM_OPACITY = 0.6; // background dimming while the orb / gallery is shown

const TAU = Math.PI * 2;

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// Promise-based tweens, ticked from the XR animation loop.
export class Animator {
	constructor() {
		this.tweens = new Set();
	}

	tween({ duration, ease = easeInOutCubic, update }) {
		return new Promise((resolve) => {
			this.tweens.add({ start: null, duration, ease, update, resolve });
		});
	}

	wait(duration) {
		return this.tween({ duration, update: () => {} });
	}

	tick(now) {
		for (const tween of this.tweens) {
			if (tween.start === null) tween.start = now;
			const progress = tween.duration > 0 ? Math.min((now - tween.start) / tween.duration, 1) : 1;
			tween.update(tween.ease(progress));
			if (progress >= 1) {
				this.tweens.delete(tween);
				tween.resolve();
			}
		}
	}

	// Resolves everything still running so pending sequences can unwind.
	clear() {
		for (const tween of this.tweens) tween.resolve();
		this.tweens.clear();
	}
}

/**
 * The panorama as a sphere that can morph between surrounding the viewer
 * (k = 0) and a small orb floating at an anchor in front of them (k = 1).
 */
export class PhotoSphere {
	constructor() {
		const geometry = new THREE.SphereGeometry(1, 128, 64);
		geometry.scale(-1, 1, 1); // view from the inside
		geometry.rotateY(-Math.PI / 2); // image centre faces -Z, matching the equirect layer
		this.material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
		// Panorama textures hold raw sRGB bytes (so they can be blitted into the XR layer); decode in the shader.
		this.material.defines = { DECODE_VIDEO_TEXTURE: '' };
		this.mesh = new THREE.Mesh(geometry, this.material);
		this.mesh.frustumCulled = false;
		this.mesh.visible = false;

		this.k = 0;
		this.orbScale = 1;
		this.spin = 0;
		this.hidden = false;
		this.spinFrom = 0;
		this.spinTo = 0;
	}

	get hasTexture() {
		return !!this.material.map;
	}

	setTexture(texture) {
		const previous = this.material.map;
		this.material.map = texture;
		this.material.needsUpdate = true;
		previous?.dispose();
	}

	// Picks the nearest full turn so the orb unwinds its idle spin while expanding.
	prepareExpand() {
		this.spinFrom = ((this.spin % TAU) + TAU) % TAU;
		this.spinTo = this.spinFrom > Math.PI ? TAU : 0;
	}

	unwind(progress) {
		this.spin = this.spinFrom + (this.spinTo - this.spinFrom) * progress;
	}

	update(headPosition, anchorPosition, dt) {
		const k = this.k;
		if (k >= 1) this.spin += dt * 0.25;
		else if (k <= 0) this.spin = 0;

		const radius = R_IMMERSED * Math.pow(R_ORB / R_IMMERSED, k) * this.orbScale;
		this.mesh.position.lerpVectors(headPosition, anchorPosition, k);
		// Seen from outside, the inside-out mapping would read mirrored.
		this.mesh.scale.set(k >= 1 ? -radius : radius, radius, radius);
		this.mesh.rotation.y = this.spin;
		this.mesh.visible = !this.hidden && this.hasTexture && radius > 1e-3;
	}

	dispose() {
		this.material.map?.dispose();
		this.material.dispose();
		this.mesh.geometry.dispose();
	}
}
