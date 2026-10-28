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
| `HOTSPOTS_ENABLED` | `true` | Markers in the panorama pointing at nearby photos |
| `HOTSPOT_MAX_DISTANCE` | `5000` | Only photos closer than this (metres) get a marker |

Without Docker (e.g. GitHub Pages) the same settings live in `config.js`.

## Gallery

`gallery.json` is a list of entries (see `_gallery.json`). JPEG, PNG, WebP and AVIF are supported.
It is generated from the photos and an optional `gallery.toml` (see `gallery.example.toml`) that holds their
names and descriptions, so they survive regenerating; photos not listed in it get default names.

```sh
python thumbs.py imgs thumb                 # thumbnails and map previews (WebP by default)
python listgenerator.py imgs --config gallery.toml --output-file gallery.json
```

`listgenerator.py` reads the GPS position from each photo's EXIF into `lat` / `lon`, and for DJI drone photos
the camera direction (`heading`, degrees from north) and height above the take-off point (`height`, metres).
Values set in `gallery.toml`, or entered by hand in `gallery.json`, are kept when you regenerate it and take priority.

```json
{ "path": "./imgs/DJI_0423.JPG", "preview": "./thumb/DJI_0423.preview.webp", "lat": 50.087451, "lon": 14.420671, "heading": 324.3, "height": 120.4 }
```

### Publishing

With a `[publish]` section (or `--publish-dir`), the gallery points at copies of the panoramas instead of the
originals, so the originals never have to be uploaded. The copies can be

- **capped** in size (`max_size`),
- **attributed**: `[exif]` `artist` / `copyright` are written into each copy, and `[nadir]` draws a round badge with
  the attribution (and a logo) straight down, where the tripod or drone would be,
- **sealed** (`seal`): `.pano` files, the image XOR-scrambled behind a header. The app unseals them in memory;
  opening or saving the file's URL gives an unreadable file.

```sh
python thumbs.py originals thumb
python listgenerator.py originals --config gallery.toml --output-file gallery.json   # [publish] dir = "imgs"
```

The gallery keeps addressing them as `./imgs/…` (`--img-path-prefix`), so the publish dir is the folder to serve as
`imgs/`: with Docker set `IMAGES_DIR` to it, for GitHub Pages zip it as `imgs/`. Up-to-date copies are skipped
(`--overwrite` redoes them). This makes taking the full panoramas harder, not
impossible: the decoded image is still in the browser for anyone using its developer tools. Sealing changes the
photo paths (`.JPG` → `.pano`), so links to a photo shared before that stop working.

### Nearby photos

Photos with a position and a `heading` show markers towards the other photos within 5 km (`HOTSPOT_MAX_DISTANCE`),
with their name and distance; click one (or point at it in VR) to go there. If the markers point the wrong way,
fix the photo's `heading`: turn the view until you look north and read `yaw` from the address bar; the heading is
`360 − yaw` (for a negative yaw, `−yaw`).

### Links

The address follows the view (`#panorama=…&yaw=…&pitch=…&zoom=…`), so a copied link, or the link button in the
top bar, opens the same photo looking the same way. `M` opens the map.

### Map

The *Map* button (and *Globe* in the VR gallery) shows a globe with a pin for every photo that has a position.
Hover or point at a pin to see the photo as a spinning orb, click / pull the trigger to open it. Photos taken at
the same place share a pin and take turns in the orb; pins that only overlap at the current zoom split up when
you select them. The globe opens where you left it last time; the
locate button goes to the photo you are viewing, and *Show on map* on a gallery card to that photo.

When the device can reach the tile server, the globe shows map tiles: the whole Earth when zoomed out, down to
street level when zoomed in, with coarser tiles filling in around the view. Tiles already loaded stay until the
cache needs room (the browser's HTTP cache keeps them across visits). Offline, a built-in NASA Blue Marble texture
is shown instead. `thumbs.py` writes small 2:1
`*.preview.webp` files that the orb loads instead of the full photo. They also show instantly when you open a
photo, on the desktop and in the VR orb, while the full-resolution photo loads.

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
| Go to a nearby photo | Point at its marker, trigger | Point at its marker, pinch |

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
