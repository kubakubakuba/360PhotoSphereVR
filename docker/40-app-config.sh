#!/bin/sh
# Writes the browser-side runtime configuration from environment variables.
set -eu

OUT=/usr/share/nginx/html/config.js

str() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/</\\u003c/g')"; }
bool() {
    case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
        1|true|yes|on) echo true ;;
        *) echo false ;;
    esac
}
num() {
    if printf '%s' "$1" | grep -Eq '^[0-9]+(\.[0-9]+)?$'; then echo "$1"; else echo "$2"; fi
}

cat > "$OUT" <<CONFIG
// Generated at container start by docker/40-app-config.sh
window.APP_CONFIG = {
	title: $(str "${APP_TITLE:-360° Photo Sphere}"),
	defaultPanorama: $(str "${DEFAULT_PANORAMA:-}"),
	galleryUrl: $(str "${GALLERY_URL:-gallery.json}"),
	vrPassthrough: $(bool "${VR_PASSTHROUGH:-true}"),
	vrUseLayers: $(bool "${VR_USE_LAYERS:-true}"),
	vrFoveation: $(num "${VR_FOVEATION:-0}" 0),
	vrFramebufferScale: $(num "${VR_FRAMEBUFFER_SCALE:-0}" 0),
	vrMaxTextureSize: $(num "${VR_MAX_TEXTURE_SIZE:-0}" 0),
};
CONFIG

echo "$0: wrote $OUT"
