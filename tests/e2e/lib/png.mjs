// Tiny PNG decoder for screenshots (8-bit RGB/RGBA, non-interlaced) and colour helpers.
import { inflateSync } from 'node:zlib';

export function decodePng(buffer) {
	let pos = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	const idat = [];
	while (pos < buffer.length) {
		const length = buffer.readUInt32BE(pos);
		const type = buffer.toString('ascii', pos + 4, pos + 8);
		const data = buffer.subarray(pos + 8, pos + 8 + length);
		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
			interlace = data[12];
		} else if (type === 'IDAT') {
			idat.push(data);
		} else if (type === 'IEND') {
			break;
		}
		pos += 12 + length;
	}
	if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
		throw new Error(`Unsupported PNG (depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`);
	}

	const channels = colorType === 6 ? 4 : 3;
	const stride = width * channels;
	const raw = inflateSync(Buffer.concat(idat));
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const current = pixels.subarray(y * stride, (y + 1) * stride);
		const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? current[x - channels] : 0;
			const b = previous ? previous[x] : 0;
			const c = previous && x >= channels ? previous[x - channels] : 0;
			let value = line[x];
			if (filter === 1) value += a;
			else if (filter === 2) value += b;
			else if (filter === 3) value += (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			current[x] = value & 0xff;
		}
	}

	return {
		width,
		height,
		// Average colour of a size×size square centred at fractional coordinates (fx, fy).
		sample(fx, fy, size = 24) {
			const cx = Math.round(fx * (width - 1));
			const cy = Math.round(fy * (height - 1));
			const sum = [0, 0, 0];
			let count = 0;
			for (let y = Math.max(0, cy - size / 2); y < Math.min(height, cy + size / 2); y++) {
				for (let x = Math.max(0, cx - size / 2); x < Math.min(width, cx + size / 2); x++) {
					const i = y * stride + x * channels;
					sum[0] += pixels[i];
					sum[1] += pixels[i + 1];
					sum[2] += pixels[i + 2];
					count++;
				}
			}
			return sum.map((value) => Math.round(value / count));
		},
	};
}

export const colorDistance = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));
export const isDark = (color, limit = 45) => color.every((value) => value < limit);
