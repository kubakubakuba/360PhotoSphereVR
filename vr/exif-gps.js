// Reads where a JPEG was taken from its header without decoding the image: the GPS position
// (EXIF) and, for DJI drone photos, the camera heading and height above the take-off point (XMP).

const HEADER_BYTES = 1024 * 1024;
const GPS_IFD_POINTER = 0x8825;
const GPS_LATITUDE_REF = 1;
const GPS_LATITUDE = 2;
const GPS_LONGITUDE_REF = 3;
const GPS_LONGITUDE = 4;
const TYPE_ASCII = 2;
const TYPE_RATIONAL = 5;

function readIfd(view, offset, little) {
	const entries = new Map();
	if (offset + 2 > view.byteLength) return entries;
	const count = view.getUint16(offset, little);
	for (let i = 0; i < count; i++) {
		const entry = offset + 2 + i * 12;
		if (entry + 12 > view.byteLength) break;
		entries.set(view.getUint16(entry, little), {
			type: view.getUint16(entry + 2, little),
			count: view.getUint32(entry + 4, little),
			valueOffset: entry + 8, // inline value, or an offset (from the TIFF header) to it
		});
	}
	return entries;
}

function readRef(view, entry) {
	if (!entry || entry.type !== TYPE_ASCII) return '';
	return String.fromCharCode(view.getUint8(entry.valueOffset));
}

// Degrees, minutes, seconds as three rationals.
function readDegrees(view, tiff, entry, little) {
	if (!entry || entry.type !== TYPE_RATIONAL || entry.count < 3) return NaN;
	const start = tiff + view.getUint32(entry.valueOffset, little);
	if (start + 24 > view.byteLength) return NaN;
	const [degrees, minutes, seconds] = [0, 1, 2].map((i) => {
		const denominator = view.getUint32(start + i * 8 + 4, little);
		return denominator ? view.getUint32(start + i * 8, little) / denominator : 0;
	});
	return degrees + minutes / 60 + seconds / 3600;
}

function parseExif(view, tiff) {
	const order = view.getUint16(tiff);
	if (order !== 0x4949 && order !== 0x4d4d) return null;
	const little = order === 0x4949;
	const ifd0 = readIfd(view, tiff + view.getUint32(tiff + 4, little), little);
	const pointer = ifd0.get(GPS_IFD_POINTER);
	if (!pointer) return null;
	const gps = readIfd(view, tiff + view.getUint32(pointer.valueOffset, little), little);

	let lat = readDegrees(view, tiff, gps.get(GPS_LATITUDE), little);
	let lon = readDegrees(view, tiff, gps.get(GPS_LONGITUDE), little);
	if (readRef(view, gps.get(GPS_LATITUDE_REF)) === 'S') lat = -lat;
	if (readRef(view, gps.get(GPS_LONGITUDE_REF)) === 'W') lon = -lon;
	// Cameras without a fix often write 0 / 0.
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
	return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

// DJI writes its flight data as XMP, either as attributes or as elements.
function parseDroneXmp(text) {
	const values = {};
	for (const [, name, attribute, element] of text.matchAll(/drone-dji:(\w+)(?:="([^"]*)"|>([^<]*)<)/g)) {
		values[name] = Number(attribute ?? element);
	}
	const yaw = [values.GimbalYawDegree, values.FlightYawDegree].find(Number.isFinite);
	const result = {};
	if (yaw !== undefined) result.heading = Math.round((((yaw % 360) + 360) % 360) * 10) / 10;
	if (Number.isFinite(values.RelativeAltitude)) result.height = Math.round(values.RelativeAltitude * 10) / 10;
	return result;
}

/**
 * Returns { lat, lon, heading, height } (each only when present) from a JPEG header, or null.
 */
export async function readPhotoMetadata(blob) {
	const view = new DataView(await blob.slice(0, HEADER_BYTES).arrayBuffer());
	if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

	const result = {};
	let i = 2;
	while (i + 4 <= view.byteLength) {
		if (view.getUint8(i) !== 0xff) break;
		const marker = view.getUint8(i + 1);
		if (marker === 0xff) { i++; continue; }
		if (marker === 0xda || marker === 0xd9) break; // image data starts, no metadata after it
		const length = view.getUint16(i + 2);
		if (marker === 0xe1) {
			// APP1 "Exif\0\0" followed by a TIFF header, or APP1 XMP
			if (i + 10 <= view.byteLength && view.getUint32(i + 4) === 0x45786966 && view.getUint16(i + 8) === 0) {
				try {
					Object.assign(result, parseExif(view, i + 10));
				} catch { /* truncated or malformed EXIF */ }
			} else {
				const end = Math.min(i + 2 + length, view.byteLength);
				const text = new TextDecoder().decode(new Uint8Array(view.buffer, i + 4, Math.max(0, end - i - 4)));
				if (text.startsWith(XMP_HEADER)) Object.assign(result, parseDroneXmp(text));
			}
		}
		i += 2 + length;
	}
	return Object.keys(result).length > 0 ? result : null;
}

/**
 * Returns { lat, lon } from a JPEG's EXIF GPS tags, or null when there are none.
 */
export async function readGps(blob) {
	const metadata = await readPhotoMetadata(blob);
	return metadata?.lat !== undefined ? { lat: metadata.lat, lon: metadata.lon } : null;
}
