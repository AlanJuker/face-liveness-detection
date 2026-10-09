# Face Liveness Detection

[![CI](https://github.com/AlanJuker/face-liveness-detection/actions/workflows/ci.yml/badge.svg)](https://github.com/AlanJuker/face-liveness-detection/actions/workflows/ci.yml)

Face liveness detection app built with Angular, TensorFlow.js and face-api
(`@vladmandic/face-api`). It verifies that a real person — not a photograph or
a recording — is in front of the camera by asking for three gestures in random
order: blink, smile, and head turn. Upon approval, it captures a face photo
(at the exact moment of the smile) as evidence.

The AI analysis happens **100% in the browser** (WebGL via TensorFlow.js): the
model weights are served as static files from `public/models/` and inference
runs client-side. A minimal Express backend stores the evidence photos in
PostgreSQL so they can be reviewed, downloaded, and deleted from any browser.

## Features

- **Live face detection** with an animated scanning overlay (sweep line, frame
  corners, pulsing oval guide).
- **Liveness challenges**: blink (adaptive eye-aspect-ratio thresholds), smile
  (facial expression model), and head turn (nose-to-jaw yaw estimation), each
  with a 20-second limit. Random order defeats pre-recorded videos; static
  photos cannot complete the gestures.
- **Onboarding carousel**: an animated, bank-style instruction wizard (remove
  accessories, find good lighting, center your face, gesture preview) shown
  before the verification starts.
- **Evidence photo**: captured while the user smiles, cropped to the face,
  mirrored back to natural orientation, downloadable as JPEG and available in
  code (`capturedPhoto` signal) for backend integration.
- **Photo gallery** (`/fotos` route): every evidence photo is stored
  server-side (PostgreSQL on Railway, or local files during development), so
  the gallery is accessible from any browser. It lists photos with capture
  date and storage usage, and lets you download or delete them (individually
  or all at once) to free up space.
- **Institutional UI**: formal Spanish copy, blue/white palette, responsive
  layout.

## Tech stack

- Angular 20 (standalone components, signals, new control flow)
- `@vladmandic/face-api` (maintained face-api.js fork, bundles TensorFlow.js)
- Models: TinyFaceDetector, 68-point face landmarks, face expressions
- Express + PostgreSQL (evidence photo API); Docker for deployment

## Local development

```bash
npm install
npm --prefix server install
npm run server     # photo API on http://localhost:3000 (stores files in server/data)
npm start          # app on http://localhost:4200 (proxies /api to :3000)
npm test           # unit tests for the liveness math (Vitest)
```

Without a `DATABASE_URL` the server stores photos as files in `server/data/`;
with one it uses PostgreSQL. Diagnostics mode (live eye/smile/yaw metrics):
open the app with `?debug`, e.g. `http://localhost:4200/?debug`.

## API

| Method | Route              | Description                          |
| ------ | ------------------ | ------------------------------------ |
| POST   | `/api/photos`      | Save a photo (`{ dataUrl }`, JPEG)   |
| GET    | `/api/photos`      | List photos + total storage used     |
| GET    | `/api/photos/:id`  | Get a photo (`?download` to attach)  |
| DELETE | `/api/photos/:id`  | Delete one photo                     |
| DELETE | `/api/photos`      | Delete all photos                    |

## Deploying to Railway

The repository ships with a multi-stage `Dockerfile` (Node builds the Angular
app; a slim Node image runs the Express server that hosts both the SPA and the
photo API) and a `railway.json`.

1. On [railway.com](https://railway.com): **New Project → Deploy from GitHub
   repo** and pick this repository. Railway auto-detects the Dockerfile.
2. In the same project: **Create → Database → Add PostgreSQL**.
3. On the app service: **Variables → New Variable → Add Reference** and select
   the Postgres `DATABASE_URL`. Railway redeploys automatically.
4. Go to **Settings → Networking** and click **Generate Domain** to get the
   public URL.

Notes:

- `getUserMedia` (camera access) requires HTTPS; the `*.up.railway.app` domain
  already provides it — no extra configuration needed.
- `PORT` is injected by Railway automatically; only `DATABASE_URL` needs to be
  referenced.

## Testing the Docker image locally

```bash
docker build -t face-liveness .
docker run --rm -p 8080:3000 face-liveness
# http://localhost:8080  (camera works on localhost even without HTTPS;
# photos are stored inside the container unless DATABASE_URL is provided)
```

## Privacy

The liveness gesture analysis runs entirely on the user's device — video never
leaves the browser. The evidence photo captured on approval, however, is
uploaded to the server and stored in PostgreSQL: that is biometric data, so
make sure your privacy notice covers consent, purpose, and retention, and use
the gallery's delete options to honor erasure requests.

The photo API has no authentication: anyone who can reach the server can list
or delete photos. Put it behind authentication before using it with real users.
