import typer
from PIL import Image
from pathlib import Path
import os
from typing import Optional

app = typer.Typer()

def crop_center_square(img: Image.Image, crop_size: int) -> Image.Image:
	"""Crop a square from the center of the image"""
	width, height = img.size
	left = (width - crop_size) / 2
	top = (height - crop_size) / 2
	right = (width + crop_size) / 2
	bottom = (height + crop_size) / 2
	
	return img.crop((left, top, right, bottom))

@app.command()
def generate_thumbs(
	input_dir: Path = typer.Argument(..., help="Directory containing 360-degree images"),
	output_dir: Path = typer.Argument(..., help="Directory to save thumbnails"),
	crop_size: int = typer.Option(2000, help="Size of center area to crop from original image"),
	thumb_size: int = typer.Option(400, help="Final thumbnail size in pixels"),
	quality: int = typer.Option(85, help="JPEG quality (1-100)"),
	suffix: str = typer.Option(".thumb", help="Suffix to append to filename"),
	overwrite: bool = typer.Option(False, help="Overwrite existing thumbnails"),
):
	"""
	Generate thumbnails from 360-degree images by cropping center portion.
	For stereographic 360 images (like DJI drone photos).
	"""
	output_dir.mkdir(parents=True, exist_ok=True)
	
	extensions = ('.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG')
	
	processed = 0
	skipped = 0
	
	for input_path in input_dir.iterdir():
		if input_path.suffix.lower() in extensions:
			output_path = output_dir / f"{input_path.stem}{suffix}{input_path.suffix}"
			
			if not overwrite and output_path.exists():
				typer.echo(f"Skipping (exists): {input_path.name}")
				skipped += 1
				continue
			
			try:
				with Image.open(input_path) as img:
					cropped = crop_center_square(img, crop_size)
					
					cropped.thumbnail((thumb_size, thumb_size))
					
					cropped.save(output_path, quality=quality)
					
					typer.echo(f"Created: {output_path.name}")
					processed += 1
					
			except Exception as e:
				typer.echo(f"Error processing {input_path.name}: {str(e)}", err=True)
	
	typer.echo(f"\nFinished: {processed} created, {skipped} skipped")

if __name__ == "__main__":
	app()