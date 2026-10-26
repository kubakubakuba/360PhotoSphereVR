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

Without Docker (e.g. GitHub Pages) the same settings live in `config.js`.

## Gallery

`gallery.json` is a list of entries (see `_gallery.json`). JPEG, PNG, WebP and AVIF are supported.

```sh
python thumbs.py imgs thumb                 # thumbnails (WebP by default)
python listgenerator.py imgs thumb --output-file gallery.json --default DJI_0423.JPG
```

### Your own photos

Drag & drop 360° photos onto the page, or use *Add photos* in the gallery. They are stored in the browser
(IndexedDB) on that device only, never uploaded to the server, and appear under *On this device* and in the
in-VR gallery. On Quest, add them in the browser before entering VR.

## VR controls

| Action | Controllers | Hands |
| --- | --- | --- |
| Open / close gallery | B / Y or grip | Pinch the *Gallery* button below your view |
| Select | Trigger | Pinch |
| Previous / next photo | Thumbstick left / right | Gallery |
| Change gallery page | Thumbstick left / right (gallery open) | Arrows under the cards |

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
