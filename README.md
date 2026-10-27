# 360PhotoSphereVR
A 360 panaroma photo viewer capable of displaying the photos as a VR content using WebXR

## Running with Docker

```sh
cp .env.example .env
docker compose up -d --build
```

Open `https://<host>:8360`. A self-signed certificate is generated on first start and kept in `./certs`.
For the headset to connect over LAN, add its address to `SSL_SAN` (e.g. `IP:192.168.1.50`), or put a trusted
`cert.pem` / `key.pem` (e.g. from [mkcert](https://github.com/FiloSottile/mkcert)) into `./certs`.

### Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HTTPS_PORT` / `HTTP_PORT` | `8360` / `8361` | Host ports (HTTP redirects to HTTPS) |
| `SERVER_NAME` | `localhost` | nginx server name and certificate CN |
| `SSL_SAN` | – | Extra certificate SANs, e.g. `IP:192.168.1.50,DNS:pano.local` |
| `IMAGES_DIR`, `THUMBS_DIR`, `GALLERY_FILE`, `CERTS_DIR` | `./imgs`, `./thumb`, `./gallery.json`, `./certs` | Host paths mounted into the container |
| `APP_TITLE` | `360° Photo Sphere` | Title shown in the page header |
| `DEFAULT_PANORAMA` | – | Panorama shown first; otherwise the gallery entry with `"default": true`, else the first entry |
| `GALLERY_URL` | `gallery.json` | Gallery catalog URL |
| `VR_PASSTHROUGH` | `true` | Show passthrough behind the in-VR gallery and transitions (when supported) |
| `VR_USE_LAYERS` | `true` | Render photos through a WebXR equirect layer for native sharpness |
| `VR_FOVEATION` | `0` | Fixed foveation, 0 (off) – 1 (max) |
| `VR_FRAMEBUFFER_SCALE` | `0` | Eye buffer scale, `0` = device native |
| `VR_MAX_TEXTURE_SIZE` | `0` | Max panorama size in VR in px, `0` = 8192 (≈ Quest 3 display resolution) |
| `GLOBE_ENABLED` | `true` | Map / globe of the photos that have a GPS position |
| `GLOBE_TILE_URL` | Esri World Imagery | Map tiles loaded when zooming in (`{z}`/`{x}`/`{y}` template, must allow CORS); `off` = built-in Earth texture only |
| `GLOBE_TILE_ATTRIBUTION` | Esri credit | Shown while tiles are visible (set it when you change the tile URL) |
| `GLOBE_TILE_MAX_ZOOM` | `17` | Most detailed tile level |

Without Docker (e.g. GitHub Pages) the same settings live in `config.js`.

## Gallery

`gallery.json` is a list of entries (see `_gallery.json`). JPEG, PNG, WebP and AVIF are supported.

```sh
python thumbs.py imgs thumb                 # thumbnails and map previews (WebP by default)
python listgenerator.py imgs thumb --output-file gallery.json --default DJI_0423.JPG
```

`listgenerator.py` reads the GPS position from each photo's EXIF (DJI drones write it) into `lat` / `lon`.
Positions you enter by hand in `gallery.json` are kept when you regenerate it, and they take priority over EXIF.

### Map

The *Map* button (and *Globe* in the VR gallery) shows a globe with a pin for every photo that has a position.
Hover or point at a pin to see the photo as a spinning orb, click / pull the trigger to open it. Photos taken at
the same place share a pin and take turns in the orb; pins that only overlap at the current zoom split up when
you select them. The globe opens where you left it last time.

When the device can reach the tile server, the globe shows map tiles: the whole Earth when zoomed out, down to
street level when zoomed in, with coarser tiles filling in around the view. Tiles already loaded stay until the
cache needs room (the browser's HTTP cache keeps them across visits). Offline, a built-in NASA Blue Marble texture
is shown instead. `thumbs.py` writes small 2:1
`*.preview.webp` files that the orb loads instead of the full photo.

### Your own photos

Drag & drop 360° photos onto the page, or use *Add photos* in the gallery. They are stored in the browser
(IndexedDB) on that device only, never uploaded to the server, and appear under *On this device* and in the
in-VR gallery. On Quest, add them in the browser before entering VR. JPEGs with a GPS position show up on the map.

## VR controls

| Action | Controllers | Hands |
| --- | --- | --- |
| Open / close gallery | B / Y or grip | Pinch the *Gallery* button below your view |
| Select | Trigger | Pinch |
| Previous / next photo | Thumbstick left / right | Gallery |
| Change gallery page | Thumbstick left / right (gallery open) | Arrows under the cards |
| Open the globe | *Globe* button in the gallery | *Globe* button in the gallery |
| Turn the globe | Trigger and drag, or thumbstick left / right | Pinch and drag |
| Zoom the globe | Thumbstick forward / back | *+* / *−* buttons |
| Back to the gallery | B / Y or grip | *Gallery* button |

Earth texture: [NASA Visible Earth, Blue Marble Next Generation](https://visibleearth.nasa.gov/collection/1484/blue-marble) (public domain).

Roadmap:
- [x] Implement PC scrolling view
- [x] Implement VR view
- [x] Implement VR menu controls
- [x] Functional VR exit
- [x] Implement local images loading
- [x] Docker compose
- [x] Fix default image (load random image from gallery folder / or load some preselected - define in gallery.json)
- [ ] Write usage manual README
- [x] Make environment variables for configurable settings (in Docker)
- [x] Map / globe of the photo locations (desktop and VR)
