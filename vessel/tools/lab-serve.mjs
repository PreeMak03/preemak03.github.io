/**
 * VESSEL Lab static server + CommandRoom write/push API.
 * Replaces plain `python -m http.server` when you want Apply Online → GitHub.
 *
 *   node vessel/tools/lab-serve.mjs
 *   → http://localhost:8765/
 *   → http://localhost:8765/vessel/command-room/
 *
 * POST /__lab/apply-online  { live, versions }
 * POST /__lab/deploy        { live, versions, deployPick, deployVersions, buildVessel? }
 * GET  /__lab/status
 * GET  /__lab/classic-list
 * GET  /__lab/classic?id=
 * GET  /__lab/classic-fields
 * POST /__lab/classic-save  { profile }  |  { id, path, value }
 * POST /__lab/vessel-seal   re-run seal-vessel.mjs
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { createReadStream } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.PORT || 8765);
const LIVE_PATH = path.join(ROOT, 'assets', 'vessel', 'live-set.json');
const CLASSIC_DIR = path.join(ROOT, 'assets', 'classic');
const SITE = 'https://preemak03.github.io/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  });
  res.end(body);
}

function readLive() {
  try {
    return JSON.parse(fs.readFileSync(LIVE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeLive(data) {
  fs.mkdirSync(path.dirname(LIVE_PATH), { recursive: true });
  fs.writeFileSync(LIVE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Run git/shell with a hard timeout so Deploy never hangs the HTTP request forever
 * (common on Windows when credential UI / dual servers block).
 * @param {string} cmd
 * @param {number} [timeoutMs]
 */
function git(cmd, timeoutMs = 120000) {
  return execSync(cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function gitOk(cmd, timeoutMs) {
  try {
    return { ok: true, out: git(cmd, timeoutMs) };
  } catch (e) {
    const timedOut = e.killed || e.signal === 'SIGTERM' || /ETIMEDOUT|timed out/i.test(String(e.message || ''));
    return {
      ok: false,
      out:
        (e.stdout || '') +
        (e.stderr || e.message || String(e)) +
        (timedOut ? '\n[timeout] command exceeded limit — check git auth / network' : ''),
    };
  }
}

function shortHead() {
  const r = gitOk('git rev-parse --short HEAD');
  return r.ok ? r.out.trim() : null;
}

/**
 * @param {'apply-online'|'deploy'} action
 * @param {object} payload
 */
function applyAndPush(action, payload) {
  const live = Array.isArray(payload.live) ? payload.live.filter(Boolean) : [];
  if (!live.length) {
    return { ok: false, status: 'error', message: 'live[] is empty — tick at least one profile' };
  }

  const versions = payload.versions && typeof payload.versions === 'object' ? payload.versions : {};
  const now = new Date().toISOString();

  // optional vessel rebuild on full deploy
  if (action === 'deploy' && payload.buildVessel !== false) {
    const build = spawnSync(process.execPath, ['vessel/tools/build.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (build.status !== 0) {
      return {
        ok: false,
        status: 'error',
        message: 'vessel build failed',
        detail: (build.stdout || '') + (build.stderr || ''),
      };
    }
  }

  // Status for API response / local disk while working (NOT committed until success)
  let doc = {
    schema: 'tas-live-set/1',
    updatedAt: now,
    source: 'command-room',
    status: 'pushing',
    message: action === 'deploy' ? 'Deploying to GitHub Pages…' : 'Applying Online set to GitHub…',
    site: SITE,
    live,
    versions,
    deployPick: Array.isArray(payload.deployPick) ? payload.deployPick : live.slice(),
    lastPush: {
      at: now,
      ok: false,
      action,
      commit: null,
    },
  };
  writeLive(doc);

  // stage ship files
  // Apply Online = carousel only (live-set). Deploy = full ship assets + live-set.
  const files = ['assets/vessel/live-set.json'];
  if (action === 'deploy') {
    files.push(
      'assets/vessel/camaro.rig.json',
      'assets/vessel/rotary.rig.json',
      'assets/vessel/american.rig.json',
      'assets/vessel/gentle.rig.json',
      'assets/vessel/camaro.vsl.json',
      'js/app.js',
      'js/profiles.js',
      'js/ui.js',
      'js/geolocation.js',
      'js/vehicle-physics.js',
      'js/animations.js',
      'js/vessel-audio.js',
      'js/vessel-runtime.worklet.js',
      'js/engine-waveguide.worklet.js',
      'js/audio-engine.js',
      'js/dynamic-volume.js',
      'js/launch-rev.js',
      'js/gearbox.js',
      'sw.js',
      'index.html',
      'css/main.css',
      'css/animations.css',
    );
    // Classic standard JSONs (tone/engine ship path)
    try {
      for (const name of fs.readdirSync(CLASSIC_DIR)) {
        if (name.endsWith('.json')) files.push(`assets/classic/${name}`);
      }
    } catch (_) {}
    // Waveguide DSP (imported by worklets / host — keep tree complete)
    try {
      const dsp = path.join(ROOT, 'js', 'dsp');
      for (const name of fs.readdirSync(dsp)) {
        if (name.endsWith('.js')) files.push(`js/dsp/${name}`);
      }
    } catch (_) {}
  }

  // Write the *final* live-set payload we want on GitHub (avoid stuck "pushing"/ok:false)
  doc = {
    ...doc,
    updatedAt: new Date().toISOString(),
    status: 'online',
    message:
      action === 'deploy'
        ? `Deployed · ${live.length} Online · live ~1 min on ${SITE}`
        : `Online applied · ${live.join(', ')} · live ~1 min on ${SITE}`,
    lastPush: {
      at: new Date().toISOString(),
      ok: true,
      action,
      commit: null, // filled after push
    },
  };
  writeLive(doc);

  for (const f of files) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) gitOk(`git add -- "${f.replace(/"/g, '')}"`);
  }

  const msg =
    action === 'deploy'
      ? `Deploy ship + Online (${live.length}): ${live.join(', ')}`
      : `Online set: ${live.join(', ')}`;

  let commit = gitOk(`git commit -m "${msg.replace(/"/g, "'")}"`);
  // nothing to commit is ok if already staged same content
  if (!commit.ok && /nothing to commit/i.test(commit.out)) {
    commit = { ok: true, out: 'nothing to commit (already up to date)\n' };
  }
  if (!commit.ok) {
    doc.status = 'error';
    doc.message = 'git commit failed';
    doc.lastPush = { at: now, ok: false, action, commit: null, detail: commit.out };
    writeLive(doc);
    return { ok: false, ...doc, detail: commit.out };
  }

  const push = gitOk('git push origin main');
  const head = shortHead();
  if (!push.ok) {
    doc.status = 'error';
    doc.message = 'git push failed — check auth (gh auth / credential manager)';
    doc.lastPush = { at: now, ok: false, action, commit: head, detail: push.out };
    writeLive(doc);
    // Best-effort: commit error status so CR shows it next time (optional)
    gitOk('git add -- assets/vessel/live-set.json');
    gitOk(`git commit -m "live-set: push failed"`);
    return { ok: false, ...doc, detail: push.out };
  }

  // Stamp commit hash into live-set and push a tiny follow-up so GitHub matches local
  doc.lastPush = { at: new Date().toISOString(), ok: true, action, commit: head };
  doc.updatedAt = new Date().toISOString();
  writeLive(doc);
  gitOk('git add -- assets/vessel/live-set.json');
  const stamp = gitOk(`git commit -m "live-set: stamp ${head}"`);
  if (stamp.ok || /nothing to commit/i.test(stamp.out || '')) {
    gitOk('git push origin main');
  }
  doc.lastPush.commit = shortHead() || head;

  return { ok: true, ...doc, detail: (push.out || '') + (commit.out || '') };
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded === '/' ? '/index.html' : decoded;
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) return null;
  return full;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }

  // --- Lab API ---
  if (p === '/__lab/status' && req.method === 'GET') {
    const live = readLive();
    const head = shortHead();
    send(res, 200, {
      ok: true,
      lab: true,
      root: ROOT,
      head,
      site: SITE,
      liveSet: live,
    });
    return;
  }

  if (p === '/__lab/apply-online' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      // Online tab: live = currently ticked Online set
      const result = applyAndPush('apply-online', {
        live: body.live,
        versions: body.versions || {},
        deployPick: body.live,
      });
      send(res, result.ok ? 200 : 500, result);
    } catch (e) {
      send(res, 500, { ok: false, status: 'error', message: String(e.message || e) });
    }
    return;
  }

  if (p === '/__lab/deploy' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      // Deploy tab: force Online = deploy picks (what you stage)
      const live = Array.isArray(body.deployPick) && body.deployPick.length
        ? body.deployPick
        : body.live;
      const result = applyAndPush('deploy', {
        live,
        versions: body.deployVersions || body.versions || {},
        deployPick: live,
        buildVessel: body.buildVessel !== false,
      });
      send(res, result.ok ? 200 : 500, result);
    } catch (e) {
      send(res, 500, { ok: false, status: 'error', message: String(e.message || e) });
    }
    return;
  }

  // --- Classic standard API ---
  if (p === '/__lab/classic-list' && req.method === 'GET') {
    try {
      const regPath = path.join(CLASSIC_DIR, 'registry.json');
      if (!fs.existsSync(regPath)) {
        send(res, 200, { ok: true, profiles: [] });
        return;
      }
      const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      send(res, 200, { ok: true, ...reg });
    } catch (e) {
      send(res, 500, { ok: false, message: String(e.message || e) });
    }
    return;
  }

  if (p === '/__lab/classic-fields' && req.method === 'GET') {
    try {
      const f = path.join(CLASSIC_DIR, 'fields.json');
      send(res, 200, {
        ok: true,
        fields: JSON.parse(fs.readFileSync(f, 'utf8')),
      });
    } catch (e) {
      send(res, 500, { ok: false, message: String(e.message || e) });
    }
    return;
  }

  if (p === '/__lab/classic' && req.method === 'GET') {
    try {
      const id = url.searchParams.get('id');
      if (!id || /[^\w.-]/.test(id)) {
        send(res, 400, { ok: false, message: 'bad id' });
        return;
      }
      const file = path.join(CLASSIC_DIR, `${id}.classic.json`);
      if (!fs.existsSync(file)) {
        send(res, 404, { ok: false, message: 'not found' });
        return;
      }
      send(res, 200, {
        ok: true,
        profile: JSON.parse(fs.readFileSync(file, 'utf8')),
      });
    } catch (e) {
      send(res, 500, { ok: false, message: String(e.message || e) });
    }
    return;
  }

  if (p === '/__lab/classic-save' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      let doc = body.profile;
      // path-set mode
      if (!doc && body.id && body.path != null) {
        const file = path.join(CLASSIC_DIR, `${body.id}.classic.json`);
        if (!fs.existsSync(file)) {
          send(res, 404, { ok: false, message: 'not found' });
          return;
        }
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        const parts = String(body.path).split('.');
        let cur = doc;
        for (let i = 0; i < parts.length - 1; i++) {
          if (cur[parts[i]] == null) cur[parts[i]] = {};
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = body.value;
      }
      if (!doc?.id) {
        send(res, 400, { ok: false, message: 'profile.id required' });
        return;
      }
      if (/[^\w.-]/.test(doc.id)) {
        send(res, 400, { ok: false, message: 'bad id' });
        return;
      }
      doc.schema = 'tas-classic/1';
      doc.standard = 'classic-audioengine/1';
      doc.updatedAt = new Date().toISOString();
      fs.mkdirSync(CLASSIC_DIR, { recursive: true });
      const out = path.join(CLASSIC_DIR, `${doc.id}.classic.json`);
      fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      // update registry
      const regPath = path.join(CLASSIC_DIR, 'registry.json');
      let reg = { schema: 'tas-classic-registry/1', profiles: [] };
      if (fs.existsSync(regPath)) reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      const list = reg.profiles || [];
      const i = list.findIndex((x) => x.id === doc.id);
      const ent = {
        id: doc.id,
        name: doc.name,
        file: `assets/classic/${doc.id}.classic.json`,
      };
      if (i >= 0) list[i] = ent;
      else list.push(ent);
      reg.profiles = list;
      reg.updatedAt = new Date().toISOString();
      fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n', 'utf8');
      send(res, 200, { ok: true, profile: doc, path: `assets/classic/${doc.id}.classic.json` });
    } catch (e) {
      send(res, 500, { ok: false, message: String(e.message || e) });
    }
    return;
  }

  if (p === '/__lab/vessel-seal' && req.method === 'POST') {
    try {
      const r = spawnSync(process.execPath, ['vessel/tools/seal-vessel.mjs'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      send(res, r.status === 0 ? 200 : 500, {
        ok: r.status === 0,
        message: r.status === 0 ? 'VESSEL standard re-sealed' : 'seal failed',
        detail: (r.stdout || '') + (r.stderr || ''),
      });
    } catch (e) {
      send(res, 500, { ok: false, message: String(e.message || e) });
    }
    return;
  }

  // --- static ---
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { ok: false, message: 'method not allowed' });
    return;
  }

  let file = safePath(p);
  if (!file) {
    send(res, 403, 'Forbidden');
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send(res, 404, 'Not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': p.startsWith('/assets/vessel/live-set') ? 'no-store' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Tesla Active Sound — Lab server (static + CommandRoom API)');
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  http://localhost:${PORT}/vessel/command-room/`);
  console.log(`  API: POST /__lab/apply-online  POST /__lab/deploy  GET /__lab/status`);
  console.log(`  API: GET  /__lab/classic-list  GET /__lab/classic?id=  POST /__lab/classic-save`);
  console.log(`  API: POST /__lab/vessel-seal`);
  console.log(`  root: ${ROOT}`);
  console.log('');
});
