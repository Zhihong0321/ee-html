'use strict';

/**
 * HTML Host Engine
 * ----------------
 * A dead-simple multi-tenant host for static HTML apps.
 *
 * - Agents push a multi-file app as a .zip via the API.
 * - Each app gets a slug and is served publicly at /app/<slug>/.
 * - Write/manage endpoints require a single API key (Bearer or x-api-key).
 * - App files + metadata live on a persistent disk (Railway volume) at DATA_DIR.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APPS_DIR = path.join(DATA_DIR, 'apps');
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || '52428800', 10); // 50 MB

// Public base URL used when reporting an app's URL back to the caller.
// Railway provides RAILWAY_PUBLIC_DOMAIN automatically.
function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.headers.host}`;
}

fs.mkdirSync(APPS_DIR, { recursive: true });

if (!API_KEY) {
  console.warn('[WARN] API_KEY is not set. Write/manage endpoints will reject all requests until you set it.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function randomSlug() {
  return 'app-' + crypto.randomBytes(4).toString('hex');
}

function appPath(slug) {
  return path.join(APPS_DIR, slug);
}

function metaPath(slug) {
  return path.join(appPath(slug), '.meta.json');
}

function appExists(slug) {
  return fs.existsSync(appPath(slug)) && fs.statSync(appPath(slug)).isDirectory();
}

function readMeta(slug) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(slug), 'utf8'));
  } catch {
    return { slug, name: slug, createdAt: null, updatedAt: null, files: 0 };
  }
}

function writeMeta(slug, meta) {
  fs.writeFileSync(metaPath(slug), JSON.stringify(meta, null, 2));
}

// All hosted apps with their public URLs, newest first.
function listApps(base) {
  return fs.readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ ...readMeta(e.name), slug: e.name, url: `${base}/app/${e.name}/` }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.meta.json') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(full);
    else n += 1;
  }
  return n;
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Safely extract a zip into targetDir, guarding against Zip Slip (path
 * traversal via crafted entry names like ../../etc/passwd).
 */
function extractZipSafely(buffer, targetDir) {
  const zip = new AdmZip(buffer);
  const resolvedTarget = path.resolve(targetDir);

  for (const entry of zip.getEntries()) {
    const entryName = entry.entryName.replace(/\\/g, '/');
    const dest = path.resolve(targetDir, entryName);

    // Ensure the resolved path stays inside the target directory.
    if (dest !== resolvedTarget && !dest.startsWith(resolvedTarget + path.sep)) {
      throw new Error(`Unsafe path in zip: ${entry.entryName}`);
    }

    if (entry.isDirectory) {
      fs.mkdirSync(dest, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }
  }

  // Many zips wrap everything in a single top-level folder. If the extracted
  // tree has exactly one directory (and no index.html at the root), flatten it.
  flattenSingleRoot(targetDir);
}

function flattenSingleRoot(targetDir) {
  const entries = fs.readdirSync(targetDir, { withFileTypes: true })
    .filter((e) => e.name !== '.meta.json');
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  if (fs.existsSync(path.join(targetDir, 'index.html'))) return;

  const inner = path.join(targetDir, entries[0].name);
  const tmp = path.join(targetDir, '.__flatten_' + crypto.randomBytes(3).toString('hex'));
  fs.renameSync(inner, tmp);
  for (const e of fs.readdirSync(tmp)) {
    fs.renameSync(path.join(tmp, e), path.join(targetDir, e));
  }
  fs.rmdirSync(tmp);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// API-key guard for write/manage endpoints.
function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({ error: 'Server has no API_KEY configured.' });
  }
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const provided = bearer || req.headers['x-api-key'] || '';

  const a = Buffer.from(String(provided));
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  next();
}

// --- Health ---------------------------------------------------------------

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// --- Management API -------------------------------------------------------

const api = express.Router();
api.use(requireApiKey);

// List all apps.
api.get('/apps', (req, res) => {
  res.json({ apps: listApps(publicBaseUrl(req)) });
});

// Get one app's metadata.
api.get('/apps/:slug', (req, res) => {
  const slug = req.params.slug;
  if (!appExists(slug)) return res.status(404).json({ error: 'App not found.' });
  res.json({ ...readMeta(slug), slug, url: `${publicBaseUrl(req)}/app/${slug}/` });
});

// Create or overwrite an app by uploading a .zip bundle.
//   field name: "bundle"  (the zip file)
//   optional:   "slug", "name"  (form fields)
api.post('/apps', upload.single('bundle'), handleUpload);

// Update (re-deploy) an existing app.
api.put('/apps/:slug', upload.single('bundle'), handleUpload);

function handleUpload(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'Missing "bundle" file (a .zip upload).' });
  }

  // Determine slug: explicit param > slug field > name field > random.
  let slug = req.params.slug || slugify(req.body.slug) || slugify(req.body.name);
  if (!slug) slug = randomSlug();

  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({
      error: 'Invalid slug. Use lowercase letters, numbers and hyphens (max 63 chars).',
    });
  }

  const dir = appPath(slug);
  const existed = appExists(slug);

  // For PUT, the app must already exist.
  if (req.method === 'PUT' && !existed) {
    return res.status(404).json({ error: 'App not found. Use POST to create.' });
  }

  const prevMeta = existed ? readMeta(slug) : null;

  // Fresh extraction: clear any previous content.
  try {
    if (existed) rmrf(dir);
    fs.mkdirSync(dir, { recursive: true });
    extractZipSafely(req.file.buffer, dir);
  } catch (err) {
    rmrf(dir);
    return res.status(400).json({ error: `Failed to process bundle: ${err.message}` });
  }

  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    rmrf(dir);
    return res.status(400).json({ error: 'Bundle must contain an index.html at its root.' });
  }

  const now = new Date().toISOString();
  const meta = {
    slug,
    name: (req.body.name || (prevMeta && prevMeta.name) || slug).toString().slice(0, 200),
    createdAt: (prevMeta && prevMeta.createdAt) || now,
    updatedAt: now,
    files: countFiles(dir),
  };
  writeMeta(slug, meta);

  res.status(existed ? 200 : 201).json({
    ...meta,
    url: `${publicBaseUrl(req)}/app/${slug}/`,
    created: !existed,
  });
}

// Delete an app.
api.delete('/apps/:slug', (req, res) => {
  const slug = req.params.slug;
  if (!appExists(slug)) return res.status(404).json({ error: 'App not found.' });
  rmrf(appPath(slug));
  res.json({ deleted: true, slug });
});

app.use('/api', api);

// --- Public static serving -------------------------------------------------

// Serve each app's files under /app/<slug>/...
// Normalize the bare path to a trailing slash so relative asset paths resolve.
// (Non-strict routing means this also matches "/app/<slug>/", so skip those to
// avoid an infinite redirect to self.)
app.get('/app/:slug', (req, res, next) => {
  if (req.path.endsWith('/')) return next();
  res.redirect(301, `/app/${req.params.slug}/`);
});

app.use('/app/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug) || !appExists(slug)) {
    return res.status(404).send('App not found.');
  }
  express.static(appPath(slug), {
    index: 'index.html',
    dotfiles: 'ignore',
    fallthrough: true,
  })(req, res, next);
});

// SPA-style fallback: unknown path inside an existing app serves its index.html.
app.use('/app/:slug', (req, res) => {
  const slug = req.params.slug;
  if (!appExists(slug)) return res.status(404).send('App not found.');
  res.sendFile(path.join(appPath(slug), 'index.html'));
});

// --- Root landing: a guide written for the AI agent that will publish here --

function maxMb() {
  return Math.round((MAX_UPLOAD_BYTES / (1024 * 1024)) * 10) / 10;
}

// Plain-text spec — easiest for an LLM to ingest. Served at "/" for non-HTML
// clients and at /llms.txt.
function hostedAppsText(base) {
  const apps = listApps(base);
  if (apps.length === 0) return '## Hosted apps (0)\n(none yet)\n';
  const lines = apps.map((a) => `- ${a.slug}  ->  ${a.url}${a.name && a.name !== a.slug ? `  (${a.name})` : ''}`);
  return `## Hosted apps (${apps.length})\n${lines.join('\n')}\n`;
}

function guideText(req, { withApps = true } = {}) {
  const base = publicBaseUrl(req);
  const appsSection = withApps ? `\n${hostedAppsText(base)}\n` : '';
  return `# HTML Host Engine — Agent Publishing Guide
${appsSection}` + `

You are an AI coding agent. This service hosts STATIC HTML apps. You upload a
zip bundle over HTTP; the service serves it at a public URL that a human can
open. Read this whole page before publishing.

## Base URL
${base}

## Authentication
Every /api/* request needs the shared API key, sent as either:
  Authorization: Bearer <API_KEY>
  x-api-key: <API_KEY>
Serving routes (/app/<slug>/) are PUBLIC and need no key. Never embed the API
key in the HTML you publish — it would be visible to humans.

## What you can publish (and the limits)
- STATIC files only: HTML, CSS, JS, images, fonts, JSON, wasm, etc.
- There is NO server-side execution. No Node/PHP/Python, no databases, no
  server routes, no secrets storage. Anything dynamic must run client-side in
  the browser (fetch to third-party APIs is fine; CORS rules apply).
- The bundle MUST be a .zip and MUST contain index.html at its ROOT.
  (If your zip wraps everything in a single top folder, it is auto-flattened.)
- Use RELATIVE asset paths (href="css/app.css", not "/css/app.css"), because
  the app is served under a sub-path /app/<slug>/.
- Max upload size: ${maxMb()} MB per bundle.
- Slug rules: lowercase a-z, 0-9 and hyphens; 1-63 chars; must start/end
  alphanumeric. You may request one or let the service generate it.
- Routing: any unknown path inside an app falls back to its index.html
  (SPA-friendly). Client-side routers should use hash or relative routing.

## Endpoints
POST   /api/apps           Create an app from a zip. -> 201
PUT    /api/apps/:slug     Replace an existing app with a new zip. -> 200
GET    /api/apps           List all apps. -> 200
GET    /api/apps/:slug     Get one app's metadata + URL. -> 200
DELETE /api/apps/:slug     Delete an app. -> 200
GET    /healthz            Liveness check (no auth). -> 200

## Create / update request (multipart/form-data)
  bundle  (file, REQUIRED)  the .zip
  slug    (text, optional)  desired slug; auto-generated if omitted
  name    (text, optional)  human-friendly display name
POST to an existing slug overwrites it. PUT requires the slug to already exist.

## Example: publish
curl -X POST ${base}/api/apps \\
  -H "Authorization: Bearer $API_KEY" \\
  -F "bundle=@build.zip;type=application/zip" \\
  -F "slug=my-landing-page" \\
  -F "name=My Landing Page"

## Example: success response (201)
{
  "slug": "my-landing-page",
  "name": "My Landing Page",
  "createdAt": "...",
  "updatedAt": "...",
  "files": 7,
  "url": "${base}/app/my-landing-page/",
  "created": true
}

Give the "url" to the human — that is the live app.

## Errors
400 bad bundle / missing index.html / invalid slug / too large
401 missing or wrong API key
404 app not found
503 server has no API_KEY configured

## Typical workflow
1. Build your static site so index.html sits at the bundle root.
2. Zip the folder CONTENTS (not the parent folder).
3. POST it to /api/apps with a descriptive slug.
4. Return the response "url" to the human.
5. To ship changes, PUT the same slug with a new zip.
`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hostedAppsHtml(base) {
  const apps = listApps(base);
  if (apps.length === 0) {
    return '<p class="empty">No apps published yet.</p>';
  }
  const rows = apps.map((a) => {
    const name = a.name && a.name !== a.slug ? `<span class="name">${esc(a.name)}</span>` : '';
    const when = a.updatedAt ? `<span class="when">${esc(a.updatedAt.slice(0, 10))}</span>` : '';
    return `<li><a href="${esc(a.url)}">${esc(a.slug)}</a>${name}${when}</li>`;
  }).join('\n');
  return `<ul class="apps">\n${rows}\n</ul>`;
}

function guideHtml(req) {
  const base = publicBaseUrl(req);
  // Apps are rendered as real links below; keep them out of the <pre> guide.
  const text = esc(guideText(req, { withApps: false }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HTML Host Engine — Agent Publishing Guide</title>
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 2rem 1.25rem 4rem; background: #0d1117; color: #c9d1d9;
    font: 15px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  main { max-width: 860px; margin: 0 auto; }
  .banner { border: 1px solid #30363d; border-left: 3px solid #2f81f7; border-radius: 6px;
    padding: .75rem 1rem; margin: 0 0 1.5rem; color: #8b949e; background: #161b22; }
  .banner b { color: #c9d1d9; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
  a { color: #2f81f7; }
  h2 { font-size: 1rem; color: #c9d1d9; margin: 0 0 .75rem; }
  ul.apps { list-style: none; padding: 0; margin: 0 0 2rem;
    border: 1px solid #30363d; border-radius: 6px; overflow: hidden; }
  ul.apps li { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap;
    padding: .55rem .9rem; border-top: 1px solid #21262d; background: #161b22; }
  ul.apps li:first-child { border-top: none; }
  ul.apps a { font-weight: 600; }
  ul.apps .name { color: #8b949e; }
  ul.apps .when { margin-left: auto; color: #6e7681; font-size: .85em; }
  .empty { color: #8b949e; border: 1px dashed #30363d; border-radius: 6px;
    padding: 1rem; margin: 0 0 2rem; }
</style>
</head>
<body>
<main>
  <div class="banner">This page is for an <b>AI coding agent</b>. It describes the API used to
  publish static HTML apps. Humans only see the deployed apps at <code>/app/&lt;slug&gt;/</code>.
  Machine-readable copy: <a href="/llms.txt">/llms.txt</a>.</div>
  <h2>Hosted apps</h2>
  ${hostedAppsHtml(base)}
  <h2>Publishing guide</h2>
  <pre>${text}</pre>
</main>
</body>
</html>`;
}

app.get('/', (req, res) => {
  // Serve the rich page to browsers, plain text to API/CLI clients & agents.
  const accept = req.headers['accept'] || '';
  if (accept.includes('text/html')) {
    res.type('html').send(guideHtml(req));
  } else {
    res.type('text/plain').send(guideText(req));
  }
});

// Always-plaintext machine-readable guide.
app.get('/llms.txt', (req, res) => {
  res.type('text/plain').send(guideText(req));
});

app.listen(PORT, () => {
  console.log(`HTML Host Engine listening on :${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
});
