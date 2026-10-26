import * as THREE from 'three';
import { easeOutCubic } from './transitions.js';

const CARD_W = 0.30;
const THUMB_H = 0.15;
const TITLE_H = 0.048;
const CARD_H = THUMB_H + TITLE_H;
const GAP = 0.03;
const COLS = 3;
const ROWS = 2;
export const PER_PAGE = COLS * ROWS;
const DISTANCE = 1.25; // distance of the panel from the viewer, used to curve the rows

const CANVAS_W = 512;
const CANVAS_H = Math.round(CANVAS_W * CARD_H / CARD_W);
const THUMB_PX = Math.round(CANVAS_W * THUMB_H / CARD_W);

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const COLORS = {
	surface: '#14171c',
	surfaceAlt: '#1d2128',
	border: 'rgba(255, 255, 255, 0.14)',
	text: '#e8eaed',
	muted: '#9aa0a6',
	danger: '#f2555a',
};

function makeCanvas(width, height) {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	return { canvas, ctx: canvas.getContext('2d') };
}

function makeTexture(canvas) {
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	return texture;
}

function ellipsize(ctx, text, maxWidth) {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let end = text.length;
	while (end > 0 && ctx.measureText(text.slice(0, end) + '…').width > maxWidth) end--;
	return text.slice(0, end) + '…';
}

function drawCover(ctx, image, x, y, width, height) {
	const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
	const sw = width / scale;
	const sh = height / scale;
	ctx.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, x, y, width, height);
}

function fileName(path) {
	return decodeURIComponent(path.split('/').pop() || path);
}

export class VRGallery {
	constructor({ items = [], accent = '#43cea2', placeholder = 'placeholder_thumbnail.png', onSelect, onExit }) {
		this.items = items;
		this.accent = accent;
		this.placeholder = placeholder;
		this.onSelect = onSelect;
		this.onExit = onExit;

		this.panel = new THREE.Group();
		this.panel.visible = false;
		this.alpha = 0;
		this.targetAlpha = 0;
		this.page = 0;
		this.current = null;

		this.images = new Map(); // thumbnail url -> { img, ready, waiting }
		this.cardEntries = new Map(); // item index -> { canvas, ctx, texture }

		this.buildCards();
		this.buildFooter();
	}

	get visible() {
		return this.targetAlpha > 0;
	}

	get pageCount() {
		return Math.max(1, Math.ceil(this.items.length / PER_PAGE));
	}

	buildCards() {
		const cardGeometry = new THREE.PlaneGeometry(CARD_W, CARD_H);
		const glowGeometry = new THREE.PlaneGeometry(CARD_W + 0.03, CARD_H + 0.03);
		const glowTexture = this.makeGlowTexture();

		this.cards = [];
		for (let i = 0; i < PER_PAGE; i++) {
			const col = i % COLS;
			const row = Math.floor(i / COLS);
			const theta = (col - (COLS - 1) / 2) * (CARD_W + GAP) / DISTANCE;

			const holder = new THREE.Group();
			holder.position.set(DISTANCE * Math.sin(theta), ((ROWS - 1) / 2 - row) * (CARD_H + GAP), DISTANCE * (1 - Math.cos(theta)));
			holder.rotation.y = -theta;

			const glow = new THREE.Mesh(glowGeometry, new THREE.MeshBasicMaterial({ map: glowTexture, transparent: true, opacity: 0, depthWrite: false }));
			const mesh = new THREE.Mesh(cardGeometry, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
			mesh.userData = {
				hover: 0,
				hoverT: 0,
				appear: 0,
				index: -1,
				onActivate: () => {
					const item = this.items[mesh.userData.index];
					if (item) this.onSelect?.(item.path);
				},
			};
			holder.add(glow, mesh);
			this.panel.add(holder);
			this.cards.push({ holder, mesh, glow });
		}
	}

	buildFooter() {
		const footerY = -(CARD_H + GAP / 2) - 0.05;
		const sideTheta = (CARD_W + GAP) / DISTANCE;

		const button = (texture, width, height, onActivate) => {
			const mesh = new THREE.Mesh(
				new THREE.PlaneGeometry(width, height),
				new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, depthWrite: false }),
			);
			mesh.userData = { hover: 0, hoverT: 0, enabled: true, onActivate };
			this.panel.add(mesh);
			return mesh;
		};

		this.prevButton = button(this.makeArrowTexture(-1), 0.05, 0.05, () => this.changePage(-1));
		this.prevButton.position.set(-0.14, footerY, 0);
		this.nextButton = button(this.makeArrowTexture(1), 0.05, 0.05, () => this.changePage(1));
		this.nextButton.position.set(0.14, footerY, 0);

		this.exitButton = button(this.makeExitTexture(), 0.15, 0.045, () => this.onExit?.());
		this.exitButton.position.set(DISTANCE * Math.sin(sideTheta), footerY, DISTANCE * (1 - Math.cos(sideTheta)));
		this.exitButton.rotation.y = -sideTheta;

		this.buttons = [this.prevButton, this.nextButton, this.exitButton];

		this.pager = makeCanvas(512, 64);
		this.pagerTexture = makeTexture(this.pager.canvas);
		this.pagerMesh = new THREE.Mesh(
			new THREE.PlaneGeometry(0.2, 0.025),
			new THREE.MeshBasicMaterial({ map: this.pagerTexture, transparent: true, opacity: 0, depthWrite: false }),
		);
		this.pagerMesh.position.set(0, footerY, 0);
		this.panel.add(this.pagerMesh);
	}

	makeGlowTexture() {
		const { canvas, ctx } = makeCanvas(256, 176);
		ctx.shadowColor = this.accent;
		ctx.shadowBlur = 14;
		ctx.fillStyle = this.accent;
		ctx.beginPath();
		ctx.roundRect(12, 12, 232, 152, 14);
		ctx.fill();
		return makeTexture(canvas);
	}

	makeArrowTexture(direction) {
		const { canvas, ctx } = makeCanvas(128, 128);
		ctx.fillStyle = COLORS.surfaceAlt;
		ctx.strokeStyle = COLORS.border;
		ctx.lineWidth = 4;
		ctx.beginPath();
		ctx.arc(64, 64, 60, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.strokeStyle = COLORS.text;
		ctx.lineWidth = 9;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.beginPath();
		ctx.moveTo(64 - direction * 10, 40);
		ctx.lineTo(64 + direction * 14, 64);
		ctx.lineTo(64 - direction * 10, 88);
		ctx.stroke();
		return makeTexture(canvas);
	}

	makeExitTexture() {
		const { canvas, ctx } = makeCanvas(384, 116);
		ctx.fillStyle = '#241417';
		ctx.strokeStyle = 'rgba(242, 85, 90, 0.55)';
		ctx.lineWidth = 4;
		ctx.beginPath();
		ctx.roundRect(2, 2, 380, 112, 56);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = COLORS.danger;
		ctx.font = `600 44px ${FONT}`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText('Exit VR', 192, 60);
		return makeTexture(canvas);
	}

	drawPager() {
		const { canvas, ctx } = this.pager;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		const pages = this.pageCount;
		if (pages <= 8) {
			const spacing = 34;
			const startX = canvas.width / 2 - ((pages - 1) * spacing) / 2;
			for (let i = 0; i < pages; i++) {
				ctx.fillStyle = i === this.page ? this.accent : 'rgba(255, 255, 255, 0.3)';
				ctx.beginPath();
				ctx.arc(startX + i * spacing, 32, i === this.page ? 10 : 7, 0, Math.PI * 2);
				ctx.fill();
			}
		} else {
			ctx.fillStyle = COLORS.muted;
			ctx.font = `500 40px ${FONT}`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(`${this.page + 1} / ${pages}`, canvas.width / 2, 34);
		}
		this.pagerTexture.needsUpdate = true;
	}

	getThumb(item, index) {
		const url = item.thumbnail || this.placeholder;
		let record = this.images.get(url);
		if (!record) {
			record = { img: new Image(), ready: false, failed: false, waiting: new Set() };
			this.images.set(url, record);
			record.img.decoding = 'async';
			record.img.onload = () => {
				record.ready = true;
				record.waiting.forEach((i) => this.cardEntries.has(i) && this.drawCard(i));
				record.waiting.clear();
			};
			record.img.onerror = () => {
				if (record.failed || url === this.placeholder) return;
				record.failed = true;
				record.img.src = this.placeholder;
			};
			record.img.src = url;
		}
		if (!record.ready) record.waiting.add(index);
		return record;
	}

	getCardEntry(index) {
		let entry = this.cardEntries.get(index);
		if (!entry) {
			const { canvas, ctx } = makeCanvas(CANVAS_W, CANVAS_H);
			entry = { canvas, ctx, texture: makeTexture(canvas) };
			this.cardEntries.set(index, entry);
			this.drawCard(index);
		}
		return entry;
	}

	drawCard(index) {
		const entry = this.cardEntries.get(index);
		const item = this.items[index];
		if (!entry || !item) return;
		const { ctx } = entry;
		const isCurrent = item.path === this.current;

		ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
		ctx.save();
		ctx.beginPath();
		ctx.roundRect(0, 0, CANVAS_W, CANVAS_H, 26);
		ctx.clip();
		ctx.fillStyle = COLORS.surface;
		ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

		const thumb = this.getThumb(item, index);
		if (thumb.ready) {
			drawCover(ctx, thumb.img, 0, 0, CANVAS_W, THUMB_PX);
		} else {
			ctx.fillStyle = COLORS.surfaceAlt;
			ctx.fillRect(0, 0, CANVAS_W, THUMB_PX);
		}

		if (item.local) {
			ctx.font = `600 22px ${FONT}`;
			const label = 'On device';
			const badgeWidth = ctx.measureText(label).width + 28;
			ctx.fillStyle = 'rgba(11, 13, 16, 0.72)';
			ctx.beginPath();
			ctx.roundRect(14, 14, badgeWidth, 38, 19);
			ctx.fill();
			ctx.fillStyle = COLORS.text;
			ctx.textBaseline = 'middle';
			ctx.fillText(label, 28, 34);
		}

		const titleY = THUMB_PX + (CANVAS_H - THUMB_PX) / 2;
		const textX = 22;
		ctx.fillStyle = COLORS.text;
		ctx.font = `600 28px ${FONT}`;
		ctx.textBaseline = 'middle';
		ctx.fillText(ellipsize(ctx, item.name || fileName(item.path), CANVAS_W - textX - 22), textX, titleY);
		ctx.restore();

		if (isCurrent) {
			ctx.strokeStyle = this.accent;
			ctx.lineWidth = 6;
			ctx.beginPath();
			ctx.roundRect(3, 3, CANVAS_W - 6, CANVAS_H - 6, 24);
			ctx.stroke();
		}
		entry.texture.needsUpdate = true;
	}

	renderPage() {
		const start = this.page * PER_PAGE;
		for (const [index, entry] of this.cardEntries) {
			if (index < start || index >= start + PER_PAGE) {
				entry.texture.dispose();
				this.cardEntries.delete(index);
			}
		}

		this.cards.forEach((card, i) => {
			const index = start + i;
			const exists = index < this.items.length;
			card.holder.visible = exists;
			card.mesh.userData.index = exists ? index : -1;
			if (!exists) return;
			card.mesh.material.map = this.getCardEntry(index).texture;
			card.mesh.material.needsUpdate = true;
			card.mesh.userData.appear = -i * 0.35;
		});

		const paged = this.pageCount > 1;
		this.prevButton.visible = paged;
		this.nextButton.visible = paged;
		this.pagerMesh.visible = paged;
		this.drawPager();
	}

	setCurrent(path) {
		const previous = this.current;
		this.current = path;
		for (const index of this.cardEntries.keys()) {
			const itemPath = this.items[index]?.path;
			if (itemPath === previous || itemPath === path) this.drawCard(index);
		}
	}

	changePage(direction) {
		if (this.pageCount <= 1) return false;
		this.page = (this.page + direction + this.pageCount) % this.pageCount;
		this.renderPage();
		return true;
	}

	show() {
		const currentIndex = this.items.findIndex((item) => item.path === this.current);
		this.page = currentIndex >= 0 ? Math.floor(currentIndex / PER_PAGE) : 0;
		this.renderPage();
		this.targetAlpha = 1;
		this.panel.visible = true;
	}

	hide() {
		this.targetAlpha = 0;
	}

	getInteractives() {
		if (!this.panel.visible || this.alpha < 0.6) return [];
		const cards = this.cards.filter((card) => card.holder.visible).map((card) => card.mesh);
		return cards.concat(this.buttons.filter((b) => b.visible && b.userData.enabled));
	}

	update(dt) {
		this.alpha += (this.targetAlpha - this.alpha) * (1 - Math.exp(-dt * 12));
		if (this.targetAlpha === 0 && this.alpha < 0.01) {
			this.alpha = 0;
			this.panel.visible = false;
		}
		if (!this.panel.visible) return;

		this.panel.scale.setScalar(0.94 + 0.06 * this.alpha);
		const hoverEase = 1 - Math.exp(-dt * 18);

		for (const card of this.cards) {
			if (!card.holder.visible) continue;
			const data = card.mesh.userData;
			data.appear = Math.min(1, data.appear + dt * 5);
			const appear = easeOutCubic(Math.max(0, data.appear));
			data.hoverT += ((data.hover > 0 ? 1 : 0) - data.hoverT) * hoverEase;

			card.mesh.scale.setScalar((0.92 + 0.08 * appear) * (1 + 0.05 * data.hoverT));
			card.glow.scale.copy(card.mesh.scale);
			card.mesh.position.z = 0.025 * data.hoverT;
			card.glow.position.z = card.mesh.position.z - 0.002;
			card.mesh.material.opacity = this.alpha * appear;
			card.glow.material.opacity = this.alpha * appear * data.hoverT * 0.9;
		}

		for (const button of this.buttons) {
			const data = button.userData;
			data.hoverT += ((data.hover > 0 ? 1 : 0) - data.hoverT) * hoverEase;
			button.scale.setScalar(1 + 0.1 * data.hoverT);
			button.material.opacity = this.alpha * (data.enabled ? 0.85 + 0.15 * data.hoverT : 0.3);
		}
		this.pagerMesh.material.opacity = this.alpha;
	}

	dispose() {
		this.panel.traverse((object) => {
			object.geometry?.dispose();
			if (object.material) {
				object.material.map?.dispose();
				object.material.dispose();
			}
		});
		this.cardEntries.forEach((entry) => entry.texture.dispose());
		this.cardEntries.clear();
		this.images.clear();
	}
}
