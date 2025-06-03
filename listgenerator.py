import typer
from pathlib import Path
import json
from typing import List, Optional
import os

app = typer.Typer()

def generate_image_id(filename: str) -> str:
	"""Generate a clean ID from filename"""
	base = os.path.splitext(filename)[0]
	return base.lower().replace(" ", "_").replace("-", "_")

@app.command()
def generate_catalog(
	images_dir: Path = typer.Argument(..., help="Directory containing panoramic images"),
	thumbs_dir: Path = typer.Argument(..., help="Directory containing thumbnails"),
	output_file: Path = typer.Option("pano_catalog.json", help="Output JSON file path"),
	img_path_prefix: str = typer.Option("./imgs/", help="Prefix for image paths in JSON"),
	thumb_path_prefix: str = typer.Option("./thumb/", help="Prefix for thumbnail paths in JSON"),
	default_description: str = typer.Option("A panoramic image.", help="Default description"),
):
	"""
	Generate a JSON catalog of panoramic images and their thumbnails.
	"""
	extensions = ('.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG')
	
	catalog = []
	
	for img_path in sorted(images_dir.iterdir()):
		if img_path.suffix.lower() in extensions:
			img_name = img_path.name
			thumb_name = f"{img_path.stem}.thumb{img_path.suffix}"
			thumb_path = thumbs_dir / thumb_name
			
			has_thumbnail = thumb_path.exists()
			
			entry = {
				"id": generate_image_id(img_path.stem),
				"name": f"Panorama {img_path.stem}",
				"path": f"{img_path_prefix}{img_name}",
				"thumbnail": f"{thumb_path_prefix}{thumb_name}" if has_thumbnail else "",
				"description": default_description
			}
			
			catalog.append(entry)

	with open(output_file, 'w') as f:
		json.dump(catalog, f, indent=2)
	
	typer.echo(f"Successfully generated catalog with {len(catalog)} images at {output_file}")

if __name__ == "__main__":
	app()