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

def thumbnail(img: Image.Image, crop_size: int, thumb_size: int) -> Image.Image:
	"""Square thumbnail from the center of the image"""
	cropped = crop_center_square(img, crop_size)
	cropped.thumbnail((thumb_size, thumb_size))
	return cropped

def preview(img: Image.Image, width: int) -> Image.Image:
	"""The whole panorama, downscaled to 2:1"""
	return img.resize((width, width // 2), Image.Resampling.LANCZOS)

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
	previews: bool = typer.Option(True, help="Also write small 2:1 previews (the spinning orb on the map)"),
	preview_width: int = typer.Option(1024, help="Preview width in pixels (height is half)"),
	preview_suffix: str = typer.Option(".preview", help="Suffix to append to preview file names"),
):
	"""
	Generate thumbnails from 360-degree images by cropping center portion.
	For stereographic 360 images (like DJI drone photos).
	With --previews (default), also a downscaled copy of the whole panorama for the map's preview orb.
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
			save_format = SAVE_FORMATS.get(extension.lower().lstrip('.'))
			outputs = [(output_dir / f"{input_path.stem}{suffix}{extension}", lambda img: thumbnail(img, crop_size, thumb_size))]
			if previews:
				outputs.append((output_dir / f"{input_path.stem}{preview_suffix}{extension}", lambda img: preview(img, preview_width)))

			pending = []
			for output_path, make in outputs:
				if overwrite or not output_path.exists():
					pending.append((output_path, make))
				else:
					typer.echo(f"Skipping (exists): {output_path.name}")
					skipped += 1
			if not pending:
				continue

			try:
				with Image.open(input_path) as img:
					for output_path, make in pending:
						result = make(img)
						if save_format == 'JPEG' and result.mode not in ('RGB', 'L'):
							result = result.convert('RGB')
						result.save(output_path, format=save_format, quality=quality)
						typer.echo(f"Created: {output_path.name}")
						processed += 1

			except Exception as e:
				typer.echo(f"Error processing {input_path.name}: {str(e)}", err=True)

	typer.echo(f"\nFinished: {processed} created, {skipped} skipped")

if __name__ == "__main__":
	app()
