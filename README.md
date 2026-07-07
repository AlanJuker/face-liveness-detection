# Face Liveness Detection

Client-side face liveness detection app built with Angular, TensorFlow.js and
face-api (`@vladmandic/face-api`). It verifies that a real person — not a
photograph or a recording — is in front of the camera by asking for three
gestures in random order: blink, smile, and head turn. Upon approval, it
captures a face photo (at the exact moment of the smile) as evidence.

All processing happens **100% in the browser** (WebGL via TensorFlow.js). No
image or biometric data ever leaves the device: the AI model weights are served
as static files from `public/models/` and inference runs client-side. There is
no backend.

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
- **Institutional UI**: formal Spanish copy, blue/white palette, responsive
  layout.

## Tech stack

- Angular 20 (standalone components, signals, new control flow)
- `@vladmandic/face-api` (maintained face-api.js fork, bundles TensorFlow.js)
- Models: TinyFaceDetector, 68-point face landmarks, face expressions
- nginx + Docker for deployment

## Local development

```bash
npm install
npm start          # http://localhost:4200
```

Diagnostics mode (live eye/smile/yaw metrics): open the app with `?debug`,
e.g. `http://localhost:4200/?debug`.

## Deploying to Railway

The repository ships with a multi-stage `Dockerfile` (Node builds, nginx
serves), an `nginx.conf.template` (binds to Railway's dynamic `$PORT`, SPA
fallback, gzip, long-lived caching for model weights and hashed bundles) and a
`railway.json`.

### Option A — from GitHub (recommended)

1. Push the project to a GitHub repository.
2. On [railway.com](https://railway.com): **New Project → Deploy from GitHub
   repo** and pick the repository. Railway auto-detects the Dockerfile.
3. Once deployed, go to **Settings → Networking** and click **Generate
   Domain** to get the public URL.

### Option B — Railway CLI (no GitHub)

```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway domain
```

Notes:

- `getUserMedia` (camera access) requires HTTPS; the `*.up.railway.app` domain
  already provides it — no extra configuration needed.
- No environment variables are required: Railway injects `PORT` and nginx picks
  it up from the template.

## Testing the Docker image locally

```bash
docker build -t face-liveness .
docker run --rm -p 8080:80 face-liveness
# http://localhost:8080  (camera works on localhost even without HTTPS)
```

## Privacy

The liveness check runs entirely on the user's device. If you integrate the
captured evidence photo with a backend, you will be processing biometric data:
make sure your privacy notice covers consent, purpose, and retention.
