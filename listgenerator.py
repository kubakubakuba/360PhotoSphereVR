import typer
from pathlib import Path
import json
import math
import re
from typing import Optional
import os
from PIL import Image, ExifTags

import publish

app = typer.Typer()

IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp', '.avif')
HEADER_BYTES = 1024 * 1024
DJI_XMP = re.compile(rb'drone-dji:(\w+)(?:="([^"]*)"|>([^<]*)<)')

def generate_image_id(filename: str) -> str:
	"""Generate a clean ID from filename"""
	base = os.path.splitext(filename)[0]
	return base.lower().replace(" ", "_").replace("-", "_")

def find_thumbnail(thumbs_dir: Path, stem: str, thumb_suffix: str) -> Optional[Path]:
	"""Find a thumbnail for the image stem in any supported format"""
	for candidate in sorted(thumbs_dir.glob(f"{stem}{thumb_suffix}.*")):
		if candidate.suffix.lower() in IMAGE_EXTENSIONS:
			return candidate
	return None

def read_gps(path: Path) -> Optional[tuple[float, float]]:
	"""Latitude and longitude from the image's EXIF GPS tags, or None"""
	try:
		with Image.open(path) as img:
			gps = img.getexif().get_ifd(ExifTags.IFD.GPSInfo)
		lat = to_degrees(gps[ExifTags.GPS.GPSLatitude])
		lon = to_degrees(gps[ExifTags.GPS.GPSLongitude])
	except Exception:
		return None
	if str(gps.get(ExifTags.GPS.GPSLatitudeRef, 'N')).strip("b'\x00 ").upper() == 'S':
		lat = -lat
	if str(gps.get(ExifTags.GPS.GPSLongitudeRef, 'E')).strip("b'\x00 ").upper() == 'W':
		lon = -lon
	# Cameras without a fix often write 0 / 0
	if not (math.isfinite(lat) and math.isfinite(lon)) or abs(lat) > 90 or abs(lon) > 180 or (lat == 0 and lon == 0):
		return None
	return round(lat, 6), round(lon, 6)

def to_degrees(value) -> float:
	"""Degrees, minutes, seconds (EXIF rationals) to decimal degrees"""
	degrees, minutes, seconds = (float(part) for part in value)
	return degrees + minutes / 60 + seconds / 3600

def read_drone_data(path: Path) -> dict:
	"""Camera heading (degrees from north) and height above take-off from DJI's XMP, when present"""
	try:
		with open(path, 'rb') as f:
			header = f.read(HEADER_BYTES)
	except OSError:
		return {}
	values = {}
	for name, attribute, element in DJI_XMP.findall(header):
		try:
			values[name.decode()] = float(attribute or element)
		except ValueError:
			pass
	data = {}
	yaw = values.get("GimbalYawDegree", values.get("FlightYawDegree"))
	if yaw is not None and math.isfinite(yaw):
		data["heading"] = round(yaw % 360, 1)
	if math.isfinite(values.get("RelativeAltitude", math.nan)):
		data["height"] = round(values["RelativeAltitude"], 1)
	return data

PLACE_FIELDS = ("lat", "lon", "heading", "height")

def read_existing_places(output_file: Path) -> dict:
	"""Position fields per image id from a previous catalog, so hand-entered values survive regeneration"""
	try:
		entries = json.loads(output_file.read_text())
	except (OSError, ValueError):
		return {}
	return {
		entry.get("id") or generate_image_id(Path(entry["path"]).stem): {field: entry[field] for field in PLACE_FIELDS if field in entry}
		for entry in entries if isinstance(entry, dict) and "path" in entry
	}

def merge_place(place: dict, values: dict) -> None:
	"""lat / lon only as a pair, heading / height on their own"""
	if "lat" in values and "lon" in values:
		place.update(lat=values["lat"], lon=values["lon"])
	place.update({field: values[field] for field in ("heading", "height") if field in values})

@app.command()
def generate_catalog(
	images_dir: Path = typer.Argument(..., help="Directory containing panoramic images (the originals)"),
	thumbs_dir: Path = typer.Argument(Path("thumb"), help="Directory containing thumbnails"),
	config_file: Optional[Path] = typer.Option(None, "--config", help="Gallery TOML with names, descriptions, attribution and publishing settings (default: gallery.toml when it exists)"),
	output_file: Path = typer.Option("pano_catalog.json", help="Output JSON file path"),
	img_path_prefix: str = typer.Option("./imgs/", help="Prefix for image paths in JSON"),
	thumb_path_prefix: str = typer.Option("./thumb/", help="Prefix for thumbnail paths in JSON"),
	thumb_suffix: str = typer.Option(".thumb", help="Suffix used by thumbs.py"),
	preview_suffix: str = typer.Option(".preview", help="Suffix of the map previews written by thumbs.py"),
	default_description: str = typer.Option("A panoramic image.", help="Default description"),
	default: Optional[str] = typer.Option(None, help="File name of the panorama shown first (overrides 'default' in the config)"),
	gps: bool = typer.Option(True, help="Read GPS positions and DJI heading / height from the photos (values already in the output file are kept)"),
	publish_dir: Optional[Path] = typer.Option(None, help="Write the served copies of the panoramas here (overrides [publish] dir)"),
	seal: Optional[bool] = typer.Option(None, "--seal/--no-seal", help="Publish scrambled .pano files (overrides [publish] seal)"),
	max_size: Optional[int] = typer.Option(None, help="Maximum width of the published panoramas, 0 = keep (overrides [publish] max_size)"),
	quality: Optional[int] = typer.Option(None, help="JPEG quality of re-encoded panoramas (overrides [publish] quality)"),
	overwrite: bool = typer.Option(False, help="Publish again even when the copies are up to date"),
):
	"""
	Generate a JSON catalog of panoramic images and their thumbnails.
	"""
	if config_file is None and Path("gallery.toml").exists():
		config_file = Path("gallery.toml")
	config = publish.load_config(config_file) if config_file else {}
	if config_file:
		typer.echo(f"Using {config_file}")

	images = {str(entry["file"]).lower(): entry for entry in config.get("img", [])}
	settings = config.get("publish", {})
	publish_dir = publish_dir or settings.get("dir")
	seal = settings.get("seal", False) if seal is None else seal
	max_size = int(settings.get("max_size", 0) if max_size is None else max_size)
	quality = int(settings.get("quality", 92) if quality is None else quality)
	exif = config.get("exif", {})
	nadir = config.get("nadir")
	if not publish_dir and (seal or max_size or exif or nadir):
		typer.echo("Warning: sealing, max_size, [exif] and [nadir] only apply with a publish dir", err=True)
	newer_than = max([path.stat().st_mtime for path in (config_file, nadir and nadir["logo"], nadir and nadir["font"]) if path] or [0])

	catalog = []
	existing_places = read_existing_places(output_file)
	located = 0
	listed = set()

	for img_path in sorted(images_dir.iterdir()):
		if img_path.suffix.lower() in IMAGE_EXTENSIONS:
			thumb_path = find_thumbnail(thumbs_dir, img_path.stem, thumb_suffix)
			info = images.get(img_path.name.lower(), {})
			if info:
				listed.add(img_path.name.lower())

			served = img_path
			if publish_dir:
				try:
					served = publish.publish_image(img_path, publish_dir, seal=seal, max_size=max_size, quality=quality,
						exif=exif, nadir=nadir, newer_than=newer_than, overwrite=overwrite)
				except Exception as e:
					typer.echo(f"Error publishing {img_path.name}: {str(e)}", err=True)
					continue

			entry = {
				"id": generate_image_id(img_path.stem),
				"name": str(info.get("name", f"Panorama {img_path.stem}")),
				"path": f"{img_path_prefix}{served.name}",
				"thumbnail": f"{thumb_path_prefix}{thumb_path.name}" if thumb_path else "",
				"description": str(info.get("desc", info.get("description", default_description)))
			}
			preview_path = find_thumbnail(thumbs_dir, img_path.stem, preview_suffix)
			if preview_path:
				entry["preview"] = f"{thumb_path_prefix}{preview_path.name}"
			if (img_path.name == default) if default else info.get("default"):
				entry["default"] = True

			place = {}
			if gps:
				position = read_gps(img_path)
				if position:
					place["lat"], place["lon"] = position
				place.update(read_drone_data(img_path))
			merge_place(place, existing_places.get(entry["id"], {}))
			merge_place(place, info)
			entry.update(place)
			if "lat" in entry:
				located += 1

			catalog.append(entry)

	for name in images.keys() - listed:
		typer.echo(f"Warning: {images[name]['file']} from the config is not in {images_dir}", err=True)
	if default and not any(entry.get("default") for entry in catalog):
		typer.echo(f"Warning: default image '{default}' not found", err=True)

	with open(output_file, 'w') as f:
		json.dump(catalog, f, indent=2)

	typer.echo(f"Successfully generated catalog with {len(catalog)} images ({located} with a GPS position) at {output_file}")

if __name__ == "__main__":
	app()
