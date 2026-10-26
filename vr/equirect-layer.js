// Shows the panorama as a WebXR compositor layer (XREquirectLayer).
// The headset compositor samples the image directly at display resolution,
// skipping the eye-buffer resampling a textured sphere mesh goes through.
// This is how native photo apps on Quest get their sharpness.

// Orientation tweaks, in case the layer turns out flipped or rotated
// relative to the sphere mesh on a given runtime.
export const EQUIRECT_FLIP_Y = true;
export const EQUIRECT_YAW_OFFSET = 0;

const RETIRE_AFTER_FRAMES = 3;

export class EquirectLayer {
	static isSupported(renderer) {
		const session = renderer.xr.getSession();
		const binding = renderer.xr.getBinding();
		// Layer creation failures are caught by the caller, which falls back to the sphere mesh.
		return !!session && !!binding && typeof binding.createEquirectLayer === 'function';
	}

	constructor(renderer) {
		this.renderer = renderer;
		this.gl = renderer.getContext();
		this.layer = null;
		this.source = null; // three.js texture holding the panorama (also used by the sphere mesh)
		this.pending = false;
		this.uploaded = false;
		this.visible = false;
		this.failed = false;
		this.retired = [];
		this.readFramebuffer = this.gl.createFramebuffer();
		this.drawFramebuffer = this.gl.createFramebuffer();
	}

	setImage(texture) {
		const { width, height } = texture.image;
		const xr = this.renderer.xr;
		const init = {
			space: xr.getReferenceSpace(),
			viewPixelWidth: width,
			viewPixelHeight: height,
			layout: 'mono',
			isStatic: true,
			radius: 0,
			centralHorizontalAngle: Math.PI * 2,
			upperVerticalAngle: Math.PI / 2,
			lowerVerticalAngle: -Math.PI / 2,
		};
		if (EQUIRECT_YAW_OFFSET) {
			const half = EQUIRECT_YAW_OFFSET / 2;
			init.transform = new XRRigidTransform(undefined, { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
		}
		const layer = xr.getBinding().createEquirectLayer(init);

		this.retire();
		this.layer = layer;
		this.source = texture;
		this.pending = true;
		this.uploaded = false;
		if (this.visible) this.applyLayers();
		console.log(`Equirect layer created (${width}x${height})`);
	}

	setVisible(visible) {
		visible = visible && !!this.layer;
		if (this.visible === visible) return;
		this.visible = visible;
		this.applyLayers();
	}

	applyLayers() {
		const session = this.renderer.xr.getSession();
		const base = this.renderer.xr.getBaseLayer();
		if (!session || !base) return;
		session.updateRenderState({ layers: this.visible && this.layer ? [this.layer, base] : [base] });
	}

	// Called once per XR frame from the render loop.
	update(frame) {
		this.retired = this.retired.filter((entry) => {
			if (--entry.frames > 0) return true;
			try { entry.layer.destroy(); } catch (error) { /* session may already be gone */ }
			return false;
		});

		// Only draw into layers attached to the render state; the mesh covers them meanwhile.
		if (!frame || !this.visible || !this.layer || !this.source) return;
		if (!this.pending && !this.layer.needsRedraw) return;

		const sourceTexture = this.renderer.properties.get(this.source).__webglTexture;
		if (!sourceTexture) return;

		const gl = this.gl;
		const { width, height } = this.source.image;
		try {
			const subImage = this.renderer.xr.getBinding().getSubImage(this.layer, frame);
			const viewport = subImage.viewport;
			const x0 = viewport.x;
			const x1 = viewport.x + viewport.width;
			const y0 = EQUIRECT_FLIP_Y ? viewport.y : viewport.y + viewport.height;
			const y1 = EQUIRECT_FLIP_Y ? viewport.y + viewport.height : viewport.y;

			// GPU-side copy: no CPU upload, so no frame stall.
			gl.disable(gl.SCISSOR_TEST);
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.readFramebuffer);
			gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sourceTexture, 0);
			gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.drawFramebuffer);
			gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, subImage.colorTexture, 0);
			const readStatus = gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER);
			const drawStatus = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER);
			if (readStatus !== gl.FRAMEBUFFER_COMPLETE || drawStatus !== gl.FRAMEBUFFER_COMPLETE) {
				throw new Error(`Incomplete framebuffer (read 0x${readStatus.toString(16)}, draw 0x${drawStatus.toString(16)})`);
			}
			gl.blitFramebuffer(0, 0, width, height, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
			gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
			gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
			this.uploaded = true;
		} catch (error) {
			console.warn('Equirect layer draw failed, falling back to sphere mesh:', error);
			this.failed = true;
		} finally {
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
			gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
			this.renderer.resetState();
			this.pending = false;
		}
	}

	get ready() {
		return this.visible && this.uploaded && !this.failed;
	}

	// Layers may still be referenced by the render state for a frame or two.
	retire() {
		if (this.layer) this.retired.push({ layer: this.layer, frames: RETIRE_AFTER_FRAMES });
		this.layer = null;
		this.source = null;
		this.uploaded = false;
	}

	dispose() {
		this.retire();
		for (const entry of this.retired) {
			try { entry.layer.destroy(); } catch (error) { /* ignore */ }
		}
		this.retired = [];
		this.gl.deleteFramebuffer(this.readFramebuffer);
		this.gl.deleteFramebuffer(this.drawFramebuffer);
	}
}
