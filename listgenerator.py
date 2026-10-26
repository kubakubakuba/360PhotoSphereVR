import typer
from pathlib import Path
import json
from typing import Optional
import os

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

@app.command()
def generate_catalog(
	images_dir: Path = typer.Argument(..., help="Directory containing panoramic images"),
	thumbs_dir: Path = typer.Argument(..., help="Directory containing thumbnails"),
	output_file: Path = typer.Option("pano_catalog.json", help="Output JSON file path"),
	img_path_prefix: str = typer.Option("./imgs/", help="Prefix for image paths in JSON"),
	thumb_path_prefix: str = typer.Option("./thumb/", help="Prefix for thumbnail paths in JSON"),
	thumb_suffix: str = typer.Option(".thumb", help="Suffix used by thumbs.py"),
	default_description: str = typer.Option("A panoramic image.", help="Default description"),
	default: Optional[str] = typer.Option(None, help="File name of the panorama shown first"),
):
	"""
	Generate a JSON catalog of panoramic images and their thumbnails.
	"""
	catalog = []

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
			if default and img_path.name == default:
				entry["default"] = True

			catalog.append(entry)

	if default and not any(entry.get("default") for entry in catalog):
		typer.echo(f"Warning: default image '{default}' not found", err=True)

	with open(output_file, 'w') as f:
		json.dump(catalog, f, indent=2)

	typer.echo(f"Successfully generated catalog with {len(catalog)} images at {output_file}")

if __name__ == "__main__":
	app()
