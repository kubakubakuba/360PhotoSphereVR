"""
Publishing of panoramas for listgenerator.py: the copies that are served instead of the originals,
optionally capped in size, with attribution in their EXIF and a badge at the nadir, and sealed
(scrambled, so the file saved from its URL is not a viewable image; the app unseals it in memory).
"""
import io
import math
import shutil
import tomllib
from pathlib import Path
from typing import Optional

import numpy as np
import typer
from PIL import Image, ImageColor, ImageDraw, ImageFont

# Must match vr/image-source.js
SEAL_MAGIC = b"PANOSEAL"
SEAL_KEY = np.array([(i * 167 + 13) & 0xff for i in range(256)], dtype=np.uint8)
SEALED_SUFFIX = ".pano"

EXIF_ARTIST = 0x013B
EXIF_COPYRIGHT = 0x8298

IMAGE_FIELDS = {"file", "name", "desc", "description", "default", "lat", "lon", "heading", "height"}
NADIR_DEFAULTS = {"text": "", "logo": "", "font": "", "radius": 18.0, "color": "#ffffff", "background": "#000000c0"}

def load_config(path: Path) -> dict:
	"""Reads the gallery TOML; relative paths in it are resolved against its directory"""
	with open(path, "rb") as f:
		config = tomllib.load(f)
	base = path.parent

	images = config.get("img", [])
	if not isinstance(images, list):
		raise typer.BadParameter(f"{path}: [[img]] entries must be an array of tables")
	for entry in images:
		if "file" not in entry:
			raise typer.BadParameter(f"{path}: an [[img]] entry has no 'file'")
		unknown = set(entry) - IMAGE_FIELDS
		if unknown:
			typer.echo(f"Warning: {path}: unknown keys for {entry['file']}: {', '.join(sorted(unknown))}", err=True)

	publish = config.get("publish", {})
	if publish.get("dir"):
		publish["dir"] = base / publish["dir"]

	if "nadir" in config:
		nadir = {**NADIR_DEFAULTS, **config["nadir"]}
		for key in ("logo", "font"):
			if nadir[key]:
				nadir[key] = base / nadir[key]
		if not nadir["text"]:
			nadir["text"] = config.get("exif", {}).get("copyright", "")
		config["nadir"] = nadir
	return config

def seal_bytes(data: bytes) -> bytes:
	"""PANOSEAL header followed by the data XOR-ed with a repeating keystream"""
	payload = np.frombuffer(data, dtype=np.uint8)
	return SEAL_MAGIC + (payload ^ np.resize(SEAL_KEY, payload.size)).tobytes()

def unseal_bytes(data: bytes) -> bytes:
	if not data.startswith(SEAL_MAGIC):
		return data
	payload = np.frombuffer(data, dtype=np.uint8, offset=len(SEAL_MAGIC))
	return (payload ^ np.resize(SEAL_KEY, payload.size)).tobytes()

def load_font(font: Optional[Path], size: int) -> ImageFont.ImageFont:
	if font:
		return ImageFont.truetype(str(font), size)
	return ImageFont.load_default(size)

def render_badge(size: int, nadir: dict) -> Image.Image:
	"""Round badge (RGBA, size x size) with the logo above the attribution text"""
	scale = 2 # drawn larger, then downscaled for smooth edges
	full = size * scale
	badge = Image.new("RGBA", (full, full), (0, 0, 0, 0))
	draw = ImageDraw.Draw(badge)
	draw.ellipse((0, 0, full - 1, full - 1), fill=ImageColor.getcolor(nadir["background"], "RGBA"))

	text = str(nadir["text"]).strip()
	text_center = 0.5
	if nadir["logo"]:
		with Image.open(nadir["logo"]) as logo:
			logo = logo.convert("RGBA")
			box = int(full * (0.4 if text else 0.6))
			logo.thumbnail((box, box), Image.Resampling.LANCZOS)
			top = int(full * 0.38) - logo.height // 2 if text else (full - logo.height) // 2
			badge.alpha_composite(logo, ((full - logo.width) // 2, top))
		text_center = 0.72

	if text:
		# Largest font size whose text fits the circle's chord at that height
		max_width = full * 0.86 * math.sqrt(max(0.0, 1 - (2 * text_center - 1) ** 2))
		max_height = full * (0.2 if nadir["logo"] else 0.3)
		font_size = int(full * 0.12)
		while font_size > 8:
			font = load_font(nadir["font"], font_size)
			left, top, right, bottom = draw.multiline_textbbox((0, 0), text, font=font, align="center")
			if right - left <= max_width and bottom - top <= max_height:
				break
			font_size = int(font_size * 0.92)
		draw.multiline_text((full / 2, full * text_center), text, font=font, anchor="mm", align="center",
			fill=ImageColor.getcolor(nadir["color"], "RGBA"))

	return badge.resize((size, size), Image.Resampling.LANCZOS)

def draw_nadir(img: Image.Image, nadir: dict) -> Image.Image:
	"""
	Projects the badge onto the bottom of an equirectangular panorama, as if it lay flat on the
	ground below the camera: readable when looking straight down while facing the image centre.
	"""
	width, height = img.size
	radius = math.radians(min(max(float(nadir["radius"]), 1.0), 60.0))
	band = min(height, math.ceil(height * radius / math.pi) + 1)
	# About one badge pixel per panorama pixel along the badge's rim
	size = max(64, min(4096, round(width * math.tan(radius) / (math.pi * radius))))
	badge = np.asarray(render_badge(size, nadir), dtype=np.float32) / 255

	top = height - band
	rows = (np.arange(top, height) + 0.5) / height
	cols = (np.arange(width) + 0.5) / width
	from_nadir = (1 - rows) * math.pi # angle from straight down
	lon = (cols - 0.5) * 2 * math.pi # 0 = image centre, positive to the right
	r = np.tan(from_nadir)[:, None] / math.tan(radius)
	x = (1 + r * np.sin(lon)[None, :]) / 2 * size - 0.5 # forward at the badge's top
	y = (1 - r * np.cos(lon)[None, :]) / 2 * size - 0.5

	# Bilinear sampling; outside the badge is transparent
	x0 = np.floor(x).astype(np.int64)
	y0 = np.floor(y).astype(np.int64)
	fx = (x - x0)[..., None]
	fy = (y - y0)[..., None]
	def sample(yy, xx):
		inside = (xx >= 0) & (xx < size) & (yy >= 0) & (yy < size)
		values = badge[np.clip(yy, 0, size - 1), np.clip(xx, 0, size - 1)]
		return values * inside[..., None]
	pixels = (sample(y0, x0) * (1 - fx) * (1 - fy) + sample(y0, x0 + 1) * fx * (1 - fy)
		+ sample(y0 + 1, x0) * (1 - fx) * fy + sample(y0 + 1, x0 + 1) * fx * fy)

	result = img.convert("RGB")
	area = np.asarray(result.crop((0, top, width, height)), dtype=np.float32) / 255
	alpha = pixels[..., 3:4]
	area = pixels[..., :3] * alpha + area * (1 - alpha)
	result.paste(Image.fromarray(np.round(area * 255).astype(np.uint8)), (0, top))
	return result

def needs_reencode(src: Path, max_size: int, exif: dict, nadir: Optional[dict]) -> bool:
	if exif.get("artist") or exif.get("copyright") or nadir:
		return True
	if max_size:
		with Image.open(src) as img:
			return img.width > max_size
	return False

def published_name(src: Path, seal: bool, reencode: bool) -> str:
	if seal:
		return src.stem + SEALED_SUFFIX
	return src.stem + ".jpg" if reencode else src.name

def encode(src: Path, max_size: int, quality: int, exif: dict, nadir: Optional[dict]) -> bytes:
	with Image.open(src) as img:
		metadata = img.getexif()
		xmp = img.info.get("xmp")
		icc = img.info.get("icc_profile")
		if max_size and img.width > max_size:
			img = img.resize((max_size, round(img.height * max_size / img.width)), Image.Resampling.LANCZOS)
		img = draw_nadir(img, nadir) if nadir and (nadir["text"] or nadir["logo"]) else img.convert("RGB")
	# As UTF-8 bytes: Pillow would replace anything outside ASCII (like ©) with '?'
	if exif.get("artist"):
		metadata[EXIF_ARTIST] = str(exif["artist"]).encode()
	if exif.get("copyright"):
		metadata[EXIF_COPYRIGHT] = str(exif["copyright"]).encode()
	out = io.BytesIO()
	options = {"exif": metadata.tobytes(), "quality": quality}
	if xmp:
		options["xmp"] = xmp
	if icc:
		options["icc_profile"] = icc
	img.save(out, format="JPEG", **options)
	return out.getvalue()

def publish_image(src: Path, out_dir: Path, *, seal: bool, max_size: int, quality: int, exif: dict,
		nadir: Optional[dict], newer_than: float = 0, overwrite: bool = False) -> Path:
	"""Writes the served copy of src into out_dir (skipped when it is up to date) and returns its path"""
	reencode = needs_reencode(src, max_size, exif, nadir)
	dst = out_dir / published_name(src, seal, reencode)
	if dst.resolve() == src.resolve():
		raise typer.BadParameter(f"Publishing {src.name} would overwrite the original, use another publish dir")
	if not overwrite and dst.exists() and dst.stat().st_mtime > max(src.stat().st_mtime, newer_than):
		return dst

	out_dir.mkdir(parents=True, exist_ok=True)
	if not reencode and not seal:
		shutil.copyfile(src, dst)
	else:
		data = encode(src, max_size, quality, exif, nadir) if reencode else src.read_bytes()
		dst.write_bytes(seal_bytes(data) if seal else data)
	typer.echo(f"Published: {dst.name}")
	return dst
