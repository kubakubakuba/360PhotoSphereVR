// Builds a minimal EXIF (APP1) segment with GPS tags, to test reading photo positions.

function toDms(value) {
	const abs = Math.abs(value);
	const degrees = Math.floor(abs);
	const minutes = Math.floor((abs - degrees) * 60);
	const seconds = Math.round(((abs - degrees) * 60 - minutes) * 60 * 10000);
	return [[degrees, 1], [minutes, 1], [seconds, 10000]];
}

/** APP1 segment (marker included) holding only a GPS IFD. */
export function exifSegment(lat, lon, { littleEndian = true } = {}) {
	const tiff = Buffer.alloc(128);
	const u16 = (value, at) => (littleEndian ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
	const u32 = (value, at) => (littleEndian ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));

	tiff.write(littleEndian ? 'II' : 'MM', 0, 'ascii');
	u16(42, 2);
	u32(8, 4); // IFD0
	// IFD0: one entry, the GPS IFD pointer
	u16(1, 8);
	u16(0x8825, 10); u16(4, 12); u32(1, 14); u32(26, 18);
	u32(0, 22);
	// GPS IFD at 26: four entries, then the rationals at 80 and 104
	u16(4, 26);
	const entry = (index, tag, type, count) => {
		const at = 28 + index * 12;
		u16(tag, at); u16(type, at + 2); u32(count, at + 4);
		return at + 8;
	};
	tiff.write(lat < 0 ? 'S\0' : 'N\0', entry(0, 1, 2, 2), 'ascii');
	u32(80, entry(1, 2, 5, 3));
	tiff.write(lon < 0 ? 'W\0' : 'E\0', entry(2, 3, 2, 2), 'ascii');
	u32(104, entry(3, 4, 5, 3));
	u32(0, 76);
	for (const [start, value] of [[80, lat], [104, lon]]) {
		toDms(value).forEach(([numerator, denominator], i) => {
			u32(numerator, start + i * 8);
			u32(denominator, start + i * 8 + 4);
		});
	}

	const header = Buffer.from([0xff, 0xe1, 0, 0, 0x45, 0x78, 0x69, 0x66, 0, 0]);
	header.writeUInt16BE(2 + 6 + tiff.length, 2);
	return Buffer.concat([header, tiff]);
}

/** Copy of a JPEG with a GPS EXIF segment right after the start-of-image marker. */
export function withGps(jpeg, lat, lon, options) {
	return Buffer.concat([jpeg.subarray(0, 2), exifSegment(lat, lon, options), jpeg.subarray(2)]);
}
