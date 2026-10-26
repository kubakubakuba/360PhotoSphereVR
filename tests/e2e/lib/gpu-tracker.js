// Injected into test pages before any app code. Tracks WebGL texture allocations so tests can
// assert how many full-size panorama textures are alive at once (window.__gpu).
(() => {
	const BIG_TEXTURE_PIXELS = 2048 * 1024; // anything this large is a panorama, not UI
	const proto = WebGL2RenderingContext.prototype;
	const sizes = new Map(); // WebGLTexture -> bytes
	const big = new Set();

	const state = {
		liveBytes: 0,
		peakBytes: 0,
		liveBig: 0,
		peakBig: 0,
		resetPeak() {
			this.peakBytes = this.liveBytes;
			this.peakBig = this.liveBig;
		},
	};
	window.__gpu = state;

	function forget(texture) {
		if (sizes.has(texture)) {
			state.liveBytes -= sizes.get(texture);
			sizes.delete(texture);
		}
		if (big.delete(texture)) state.liveBig--;
	}

	function record(gl, target, bytes, pixels) {
		if (target !== gl.TEXTURE_2D) return;
		const texture = gl.getParameter(gl.TEXTURE_BINDING_2D);
		if (!texture) return;
		forget(texture);
		sizes.set(texture, bytes);
		state.liveBytes += bytes;
		if (pixels >= BIG_TEXTURE_PIXELS) {
			big.add(texture);
			state.liveBig++;
		}
		state.peakBytes = Math.max(state.peakBytes, state.liveBytes);
		state.peakBig = Math.max(state.peakBig, state.liveBig);
	}

	const texStorage2D = proto.texStorage2D;
	proto.texStorage2D = function (target, levels, internalFormat, width, height) {
		texStorage2D.apply(this, arguments);
		let bytes = 0;
		for (let level = 0; level < levels; level++) bytes += Math.max(1, width >> level) * Math.max(1, height >> level) * 4;
		record(this, target, bytes, width * height);
	};

	const texImage2D = proto.texImage2D;
	proto.texImage2D = function (...args) {
		texImage2D.apply(this, args);
		if (args[1] !== 0) return; // mip levels are accounted with level 0
		let width;
		let height;
		if (args.length >= 8 && typeof args[3] === 'number') {
			width = args[3];
			height = args[4];
		} else {
			const source = args[args.length - 1];
			width = source?.width;
			height = source?.height;
		}
		if (width && height) record(this, args[0], width * height * 4, width * height);
	};

	const deleteTexture = proto.deleteTexture;
	proto.deleteTexture = function (texture) {
		forget(texture);
		return deleteTexture.call(this, texture);
	};
})();
