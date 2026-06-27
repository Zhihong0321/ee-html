# HTML Host Engine

A dead-simple, single-service host for static HTML apps. An AI coding agent
pushes a multi-file app as a `.zip` over a tiny HTTP API; the host extracts it,
assigns a URL, and serves it publicly. One shared API key protects all
write/manage operations.

```
Agent ──POST /api/apps (zip)──▶  Host (Railway)  ──serves──▶  /app/<slug>/
```

## How it works

- **One Railway service** serves many apps. Each app lives in its own folder on
  a persistent volume and is served at `/<base>/app/<slug>/`.
- **A bundle** is a `.zip` that must contain `index.html` at its root (CSS, JS,
  images, subfolders all welcome). If the zip wraps everything in a single top
  folder, the host auto-flattens it.
- **Auth:** every `/api/*` call needs the API key via `Authorization: Bearer <key>`
  or `x-api-key: <key>`. Serving (`/app/...`) is public.
- **Storage:** files + a `.meta.json` per app under `DATA_DIR` (a Railway volume).

## API

All endpoints below require the API key.

| Method | Path              | Purpose                                   |
|--------|-------------------|-------------------------------------------|
| POST   | `/api/apps`       | Create app from a zip (`bundle` field).   |
| PUT    | `/api/apps/:slug` | Re-deploy an existing app (new zip).      |
| GET    | `/api/apps`       | List all apps.                            |
| GET    | `/api/apps/:slug` | Get one app's metadata + URL.             |
| DELETE | `/api/apps/:slug` | Delete an app.                            |
| GET    | `/healthz`        | Health check (no auth).                   |
| GET    | `/`               | Agent publishing guide + directory of hosted apps (HTML for browsers, plain text for CLI/agents). No auth. |
| GET    | `/llms.txt`       | Same guide + app list, always plain text — point your agent here. |

The intended **user of this service is an AI coding agent**; humans only ever
see the deployed apps at `/app/<slug>/`. The frontpage (`/`) is a self-describing
guide an agent can read to learn the API, the bundle contract, and the limits.
It renders the live base URL and current size limit, so it's always accurate,
and it lists every hosted app (slug → public URL, newest first) as a public
directory. The authenticated `GET /api/apps` returns the same list as JSON.

### Create / push an app

`multipart/form-data` with:
- `bundle` — the `.zip` file (**required**)
- `slug` — optional desired slug (`a-z 0-9 -`, max 63). Auto-generated if omitted.
- `name` — optional human-friendly name.

```bash
curl -X POST https://your-app.up.railway.app/api/apps \
  -H "Authorization: Bearer $API_KEY" \
  -F "bundle=@my-app.zip;type=application/zip" \
  -F "slug=landing-page" \
  -F "name=Landing Page"
```

Response:

```json
{
  "slug": "landing-page",
  "name": "Landing Page",
  "createdAt": "2026-06-27T10:00:00.000Z",
  "updatedAt": "2026-06-27T10:00:00.000Z",
  "files": 7,
  "url": "https://your-app.up.railway.app/app/landing-page/",
  "created": true
}
```

POST to an existing slug overwrites it; use `PUT /api/apps/:slug` to be explicit.

### Helper scripts (zip + upload in one step)

```bash
# bash
HOST=https://your-app.up.railway.app API_KEY=xxx \
  ./scripts/push.sh ./my-app-dir landing-page "Landing Page"
```

```powershell
# PowerShell
$env:HOST="https://your-app.up.railway.app"; $env:API_KEY="xxx"
./scripts/push.ps1 -Dir ./my-app-dir -Slug landing-page -Name "Landing Page"
```

## Deploying to Railway

1. Push this repo to GitHub and create a new Railway project **from the repo**
   (it auto-detects the `Dockerfile`).
2. **Add a Volume** to the service and set its **mount path to `/data`**
   (Railway: service → *Variables/Settings* → *Volumes*). This is what makes
   apps survive restarts/redeploys.
3. Set service **Variables**:
   - `API_KEY` — your shared secret (e.g. `openssl rand -hex 32`).
   - `DATA_DIR` — `/data` (matches the volume mount; the Dockerfile already
     defaults to this).
   - *(optional)* `MAX_UPLOAD_BYTES`, `PUBLIC_BASE_URL`.
4. Deploy. Railway provides `PORT` and `RAILWAY_PUBLIC_DOMAIN` automatically;
   the reported app URLs use that domain.

> Without a volume mounted at `/data`, uploaded apps are wiped on every redeploy.

## Run locally

```bash
npm install
API_KEY=dev-key DATA_DIR=./data npm start
# -> http://localhost:3000
```

## Notes / limits (MVP)

- Single shared API key; no per-user isolation.
- Static files only — no server-side code execution per app.
- Zip extraction is guarded against path traversal (zip-slip).
- Management is API-only (no dashboard).
