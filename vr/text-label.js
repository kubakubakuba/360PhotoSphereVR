import * as THREE from 'three';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const COLORS = {
	background: 'rgba(18, 20, 24, 0.85)',
	border: 'rgba(255, 255, 255, 0.14)',
	text: '#e8eaed',
	muted: 'rgba(232, 234, 237, 0.45)',
	accent: '#43cea2',
};

/**
 * A pill-shaped text plane drawn on top of the scene (also over the equirect layer).
 * Content is a list of parts: plain strings, or { text, style: 'accent' | 'muted' }.
 */
export class TextLabel extends THREE.Mesh {
	constructor({ height = 0.04, maxWidth = 0.5, fontSize = 40 } = {}) {
		super(
			new THREE.PlaneGeometry(1, 1),
			new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
		);
		this.heightMeters = height;
		this.maxWidth = maxWidth;
		this.fontSize = fontSize;
		this.renderOrder = 6;
		this.visible = false;
		this.hasContent = false;
		this.key = '';
	}

	setText(text) {
		this.setParts(text ? [text] : []);
	}

	setParts(parts) {
		const normalized = parts.map((part) => (typeof part === 'string' ? { text: part } : { ...part }));
		const key = JSON.stringify(normalized);
		if (key === this.key) return;
		this.key = key;
		this.hasContent = normalized.some((part) => part.text);
		this.material.map?.dispose();
		this.material.map = null;
		if (!this.hasContent) {
			this.visible = false;
			return;
		}

		const fontSize = this.fontSize;
		const canvasHeight = Math.round(fontSize * 2);
		const padding = Math.round(fontSize * 0.8);
		const pxPerMeter = canvasHeight / this.heightMeters;
		const maxTextWidth = this.maxWidth * pxPerMeter - padding * 2;

		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');
		const font = (part) => `${part.style === 'accent' ? 700 : 500} ${fontSize}px ${FONT}`;
		const measure = (part) => {
			ctx.font = font(part);
			return ctx.measureText(part.text).width;
		};

		// Shorten the last part until everything fits.
		let total = normalized.reduce((sum, part) => sum + measure(part), 0);
		const last = normalized[normalized.length - 1];
		while (total > maxTextWidth && last.text.length > 1) {
			last.text = `${last.text.replace(/…$/, '').slice(0, -1)}…`;
			total = normalized.reduce((sum, part) => sum + measure(part), 0);
		}

		canvas.width = Math.ceil(total + padding * 2);
		canvas.height = canvasHeight;
		ctx.fillStyle = COLORS.background;
		ctx.strokeStyle = COLORS.border;
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.roundRect(1.5, 1.5, canvas.width - 3, canvas.height - 3, canvas.height / 2);
		ctx.fill();
		ctx.stroke();

		let x = padding;
		ctx.textBaseline = 'middle';
		for (const part of normalized) {
			ctx.font = font(part);
			ctx.fillStyle = COLORS[part.style] || COLORS.text;
			ctx.fillText(part.text, x, canvasHeight / 2 + 1);
			x += ctx.measureText(part.text).width;
		}

		const texture = new THREE.CanvasTexture(canvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.anisotropy = 4;
		this.material.map = texture;
		this.material.needsUpdate = true;
		this.scale.set(canvas.width / pxPerMeter, this.heightMeters, 1);
	}

	setOpacity(opacity) {
		this.material.opacity = opacity;
		this.visible = this.hasContent && opacity > 0.01;
	}
}
