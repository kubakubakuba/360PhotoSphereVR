import typer
from PIL import Image
from pathlib import Path

app = typer.Typer()

# AVIF needs Pillow >= 11.3
IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp', '.avif')
SAVE_FORMATS = {'webp': 'WEBP', 'jpg': 'JPEG', 'jpeg': 'JPEG', 'png': 'PNG', 'avif': 'AVIF'}

def crop_center_square(img: Image.Image, crop_size: int) -> Image.Image:
	"""Crop a square from the center of the image"""
	width, height = img.size
	crop_size = min(crop_size, width, height)
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
	quality: int = typer.Option(85, help="Encoder quality (1-100)"),
	suffix: str = typer.Option(".thumb", help="Suffix to append to filename"),
	format: str = typer.Option("webp", help="Thumbnail format: webp, jpg, png, avif or 'same' to keep the source format"),
	overwrite: bool = typer.Option(False, help="Overwrite existing thumbnails"),
):
	"""
	Generate thumbnails from 360-degree images by cropping center portion.
	For stereographic 360 images (like DJI drone photos).
	"""
	output_dir.mkdir(parents=True, exist_ok=True)
	format = format.lower().lstrip('.')
	if format != 'same' and format not in SAVE_FORMATS:
		raise typer.BadParameter(f"Unsupported format '{format}'")

	processed = 0
	skipped = 0

	for input_path in sorted(input_dir.iterdir()):
		if input_path.suffix.lower() in IMAGE_EXTENSIONS:
			extension = input_path.suffix if format == 'same' else f".{format}"
			output_path = output_dir / f"{input_path.stem}{suffix}{extension}"

			if not overwrite and output_path.exists():
				typer.echo(f"Skipping (exists): {input_path.name}")
				skipped += 1
				continue

			try:
				with Image.open(input_path) as img:
					cropped = crop_center_square(img, crop_size)

					cropped.thumbnail((thumb_size, thumb_size))

					save_format = SAVE_FORMATS.get(extension.lower().lstrip('.'))
					if save_format == 'JPEG' and cropped.mode not in ('RGB', 'L'):
						cropped = cropped.convert('RGB')

					cropped.save(output_path, format=save_format, quality=quality)

					typer.echo(f"Created: {output_path.name}")
					processed += 1

			except Exception as e:
				typer.echo(f"Error processing {input_path.name}: {str(e)}", err=True)

	typer.echo(f"\nFinished: {processed} created, {skipped} skipped")

if __name__ == "__main__":
	app()
