import typer
from pathlib import Path
import json
import math
from typing import Optional
import os
from PIL import Image, ExifTags

app = typer.Typer()

IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp', '.avif')

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

def read_existing_positions(output_file: Path) -> dict:
	"""lat / lon per path from a previous catalog, so hand-entered positions survive regeneration"""
	try:
		entries = json.loads(output_file.read_text())
	except (OSError, ValueError):
		return {}
	return {
		entry["path"]: (entry["lat"], entry["lon"])
		for entry in entries if isinstance(entry, dict) and "path" in entry and "lat" in entry and "lon" in entry
	}

@app.command()
def generate_catalog(
	images_dir: Path = typer.Argument(..., help="Directory containing panoramic images"),
	thumbs_dir: Path = typer.Argument(..., help="Directory containing thumbnails"),
	output_file: Path = typer.Option("pano_catalog.json", help="Output JSON file path"),
	img_path_prefix: str = typer.Option("./imgs/", help="Prefix for image paths in JSON"),
	thumb_path_prefix: str = typer.Option("./thumb/", help="Prefix for thumbnail paths in JSON"),
	thumb_suffix: str = typer.Option(".thumb", help="Suffix used by thumbs.py"),
	preview_suffix: str = typer.Option(".preview", help="Suffix of the map previews written by thumbs.py"),
	default_description: str = typer.Option("A panoramic image.", help="Default description"),
	default: Optional[str] = typer.Option(None, help="File name of the panorama shown first"),
	gps: bool = typer.Option(True, help="Read GPS positions from EXIF (positions already in the output file are kept)"),
):
	"""
	Generate a JSON catalog of panoramic images and their thumbnails.
	"""
	catalog = []
	existing_positions = read_existing_positions(output_file)
	located = 0

	for img_path in sorted(images_dir.iterdir()):
		if img_path.suffix.lower() in IMAGE_EXTENSIONS:
			thumb_path = find_thumbnail(thumbs_dir, img_path.stem, thumb_suffix)

			entry = {
				"id": generate_image_id(img_path.stem),
				"name": f"Panorama {img_path.stem}",
				"path": f"{img_path_prefix}{img_path.name}",
				"thumbnail": f"{thumb_path_prefix}{thumb_path.name}" if thumb_path else "",
				"description": default_description
			}
			preview_path = find_thumbnail(thumbs_dir, img_path.stem, preview_suffix)
			if preview_path:
				entry["preview"] = f"{thumb_path_prefix}{preview_path.name}"
			if default and img_path.name == default:
				entry["default"] = True

			position = existing_positions.get(entry["path"]) or (read_gps(img_path) if gps else None)
			if position:
				entry["lat"], entry["lon"] = position
				located += 1

			catalog.append(entry)

	if default and not any(entry.get("default") for entry in catalog):
		typer.echo(f"Warning: default image '{default}' not found", err=True)

	with open(output_file, 'w') as f:
		json.dump(catalog, f, indent=2)

	typer.echo(f"Successfully generated catalog with {len(catalog)} images ({located} with a GPS position) at {output_file}")

if __name__ == "__main__":
	app()
