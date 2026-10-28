FROM nginx:1.27-alpine

RUN apk add --no-cache openssl

# Defaults, override with environment variables (see .env.example)
ENV SERVER_NAME=localhost \
    HTTPS_PORT=8360 \
    SSL_SAN="" \
    APP_TITLE="360° Photo Sphere" \
    DEFAULT_PANORAMA="" \
    GALLERY_URL="gallery.json" \
    VR_PASSTHROUGH=true \
    VR_USE_LAYERS=true \
    VR_FOVEATION=0 \
    VR_FRAMEBUFFER_SCALE=0 \
    VR_MAX_TEXTURE_SIZE=0 \
    GLOBE_ENABLED=true \
    GLOBE_TILE_MAX_ZOOM=17 \
    HOTSPOTS_ENABLED=true \
    HOTSPOT_MAX_DISTANCE=5000

COPY docker/default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/30-gen-cert.sh docker/40-app-config.sh /docker-entrypoint.d/
RUN chmod +x /docker-entrypoint.d/30-gen-cert.sh /docker-entrypoint.d/40-app-config.sh

WORKDIR /usr/share/nginx/html
RUN rm -f index.html

COPY index.html style.css app.js viewer.js globe-view.js panorama-hotspots.js local-library.js config.js placeholder_thumbnail.png ./
COPY vr/ ./vr/
COPY lib/ ./lib/
