// Desktroo PDF — © 2026 Mdm-services.fr. Tous droits réservés.
// Logiciel propriétaire, distribué avec l'abonnement Desktroo (https://desktroo.fr).
// Lire, annoter et modifier les PDF du NAS dans une fenêtre du bureau. L'éditeur est PdfCraft (version web officielle,
// non modifiée, MIT OR Apache-2.0, servie sous /engine/) ; cette app ne fait que lui passer les fichiers du NAS et
// enregistrer ce qu'il renvoie, dans les dossiers que l'administrateur a confiés à l'app (DESKTROO_NAS).
// Serveur minimal, sans dépendance. L'identité vient de Desktroo (en-têtes posés par son nginx) et n'est acceptée
// qu'avec le secret de cette installation.
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const dav = require('./dav');

const PORT = 8080;
const SECRET = process.env.DESKTROO_APP_SECRET || '';
const PUB = path.join(__dirname, 'public');
const ENGINE = path.join(__dirname, 'engine');
const MAX_PDF = 512 * 1024 * 1024;          // limite d'ouverture de PdfCraft côté hôte
const MAX_LIST = 2000;

// Dossiers confiés par l'administrateur dans Desktroo Apps : [{label, mount, path, mode}]
function roots() {
  let list = [];
  try { list = JSON.parse(process.env.DESKTROO_NAS || '[]'); } catch (_) { list = []; }
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && /^[A-Za-z0-9_.-]{1,64}$/.test(String(r.label || '')) && String(r.mount || '').startsWith('/nas/'))
    .map((r) => ({ label: String(r.label), mount: path.resolve(String(r.mount)), path: String(r.path || ''), mode: r.mode === 'rw' ? 'rw' : 'ro' }));
}

const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const HOST_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
  + "connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

function send(res, code, body, type, extra) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Length': b.length,
    'Cache-Control': 'no-store' }, HEADERS, extra || {}));
  res.end(b);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
function fail(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function identity(req) {
  if (!SECRET) return null;   // sans secret, personne n'est accepté : l'app n'a de sens que dans Desktroo
  if (!safeEq(req.headers['x-desktroo-secret'], SECRET)) return null;
  let u = '';
  try { u = decodeURIComponent(String(req.headers['x-desktroo-user'] || '')); } catch (_) { return null; }
  return /^[A-Za-z0-9._@-]{1,64}$/.test(u) ? u : null;
}

// Chemin demandé → chemin réel, toujours à l'intérieur d'un dossier confié (liens symboliques compris).
async function resolveIn(rootLabel, rel, opts) {
  rootLabel = String(rootLabel || '').replace(/^nas:/, '');
  const r = roots().find((x) => x.label === rootLabel);
  if (!r) throw fail('Dossier inconnu.', 404);
  const clean = String(rel || '').replace(/\\/g, '/');
  if (clean.split('/').some((p) => p === '..') || clean.includes('\0')) throw fail('Chemin refusé.', 400);
  const abs = path.resolve(r.mount, '.' + path.posix.sep + clean);
  const inside = (p) => p === r.mount || p.startsWith(r.mount + path.sep);
  if (!inside(abs)) throw fail('Chemin refusé.', 400);
  let real;
  try { real = await fsp.realpath(opts && opts.parent ? path.dirname(abs) : abs); }
  catch (_) { throw fail('Introuvable.', 404); }
  const rootReal = await fsp.realpath(r.mount);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw fail('Chemin refusé.', 400);
  return { root: r, abs: opts && opts.parent ? path.join(real, path.basename(abs)) : real };
}

const isPdf = (n) => /\.pdf$/i.test(n);

// Flux qui n'accepte qu'un contenu commençant par « %PDF- » et pas plus de MAX_PDF octets.
function pdfGuard() {
  let head = Buffer.alloc(0), ok = false, n = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      if (n > MAX_PDF) return cb(fail('Fichier trop gros (512 Mo au plus).', 413));
      if (!ok) {
        head = Buffer.concat([head, chunk]);
        if (head.length < 5) return cb();
        if (head.subarray(0, 5).toString('latin1') !== '%PDF-') return cb(fail('Le contenu reçu n’est pas un PDF.', 400));
        ok = true; chunk = head;
      }
      cb(null, chunk);
    },
    flush(cb) { cb(ok ? null : fail('Le contenu reçu n’est pas un PDF.', 400)); },
  });
}

async function readJson(req) {
  const parts = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 16384) throw fail('Requête trop grosse.', 413); parts.push(c); }
  try { const o = JSON.parse(Buffer.concat(parts).toString('utf8')); if (o && typeof o === 'object') return o; } catch (_) { /* invalide */ }
  throw fail('Requête invalide.');
}
const hidden = (n) => n.startsWith('.') || n === '@eaDir' || n === '#recycle' || n === '$RECYCLE.BIN';

async function apiList(q) {
  const { abs } = await resolveIn(q.get('root'), q.get('dir'));
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) throw fail('Ce n’est pas un dossier.', 400);
  const names = await fsp.readdir(abs);
  const out = [];
  for (const n of names) {
    if (hidden(n) || out.length >= MAX_LIST) continue;
    try {
      const s = await fsp.stat(path.join(abs, n));
      if (s.isDirectory()) out.push({ name: n, dir: true });
      else if (s.isFile() && isPdf(n)) out.push({ name: n, size: s.size, mtime: Math.round(s.mtimeMs) });
    } catch (_) { /* fichier illisible pour ce compte : ignoré */ }
  }
  out.sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true }));
  return { entries: out, truncated: names.length > MAX_LIST };
}

async function apiRead(req, res, q, user) {
  const { abs } = await resolveIn(q.get('root'), q.get('path'));
  if (!isPdf(abs)) throw fail('Seuls les fichiers PDF s’ouvrent ici.', 415);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw fail('Introuvable.', 404);
  if (st.size > MAX_PDF) throw fail('Fichier trop gros (512 Mo au plus).', 413);
  console.log(`[pdf] ${user} ouvre ${q.get('root')}/${q.get('path')}`);
  res.writeHead(200, Object.assign({ 'Content-Type': 'application/pdf', 'Content-Length': st.size, 'Cache-Control': 'no-store',
    'X-Mtime': String(Math.round(st.mtimeMs)) }, HEADERS));
  fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
}

async function apiWrite(req, res, q, user) {
  const name = path.basename(String(q.get('path') || ''));
  if (!isPdf(name) || hidden(name) || !/^[^/\\:*?"<>|\x00-\x1f]{1,255}$/.test(name)) throw fail('Nom de fichier invalide (il doit finir par .pdf).', 400);
  const { root, abs } = await resolveIn(q.get('root'), q.get('path'), { parent: true });
  if (root.mode !== 'rw') throw fail('Ce dossier est en lecture seule pour l’app : enregistrez ailleurs, ou changez son accès dans Desktroo Apps.', 403);
  let exists = false;
  try { exists = (await fsp.stat(abs)).isFile(); } catch (_) { exists = false; }
  if (exists && q.get('overwrite') !== '1') throw fail('Un fichier porte déjà ce nom.', 409);
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_PDF) throw fail('Fichier trop gros (512 Mo au plus).', 413);
  // Écriture dans un fichier temporaire du même dossier, puis remplacement : un enregistrement coupé ne laisse jamais un PDF à moitié écrit.
  const tmp = path.join(path.dirname(abs), '.' + name + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
  let n = 0, head = null;
  const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o664 });
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (c) => {
        n += c.length;
        if (!head) head = c.subarray(0, 5);
        if (n > MAX_PDF) { reject(fail('Fichier trop gros (512 Mo au plus).', 413)); req.destroy(); return; }
        if (!out.write(c)) { req.pause(); out.once('drain', () => req.resume()); }
      });
      req.on('end', () => out.end(resolve));
      req.on('error', reject);
      out.on('error', reject);
    });
    if (!head || head.toString('latin1') !== '%PDF-') throw fail('Le contenu reçu n’est pas un PDF.', 400);
    await fsp.rename(tmp, abs);
  } catch (e) {
    out.destroy();
    await fsp.unlink(tmp).catch(() => {});
    if (e.code === 'EACCES' || e.code === 'EPERM') throw fail('Le compte prêté à l’app n’a pas le droit d’écrire ici.', 403);
    throw e;
  }
  console.log(`[pdf] ${user} enregistre ${q.get('root')}/${q.get('path')} (${n} octets${exists ? ', remplacé' : ''})`);
  return { ok: true, size: n, replaced: exists };
}

// Fichiers de l'éditeur : noms à empreinte (cache longue durée), .wasm et .js précompressés en gzip au build.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8' };
async function serveStatic(req, res, base, rel, extra) {
  const abs = path.resolve(base, '.' + path.posix.sep + rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return send(res, 404, 'Introuvable');
  let st;
  try { st = await fsp.stat(abs); } catch (_) { return send(res, 404, 'Introuvable'); }
  if (!st.isFile()) return send(res, 404, 'Introuvable');
  const ext = path.extname(abs).toLowerCase();
  const hashed = /-[0-9a-f]{16}(_bg)?\.(js|wasm)$/.test(abs) || abs.includes(path.sep + 'snippets' + path.sep);
  const h = Object.assign({ 'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache', 'Vary': 'Accept-Encoding' }, HEADERS, extra || {});
  let file = abs, size = st.size;
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    try { const g = await fsp.stat(abs + '.gz'); file = abs + '.gz'; size = g.size; h['Content-Encoding'] = 'gzip'; } catch (_) { /* pas de version compressée */ }
  }
  h['Content-Length'] = size;
  res.writeHead(200, h);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://app');
  const p = url.pathname;
  if (p === '/healthz') return send(res, 200, 'ok');
  const user = identity(req);
  if (!user) return send(res, 403, 'Cette app s’ouvre depuis Desktroo.');
  try {
    if (p === '/' || p === '/index.html') return await serveStatic(req, res, PUB, 'index.html', { 'Content-Security-Policy': HOST_CSP });
    if (p === '/icon.svg') return await serveStatic(req, res, PUB, 'icon.svg');
    if (p === '/engine') return send(res, 301, '', 'text/plain', { Location: 'engine/' });
    if (p.startsWith('/engine/')) {
      const rel = decodeURIComponent(p.slice('/engine/'.length)) || 'index.html';
      return await serveStatic(req, res, ENGINE, rel, { 'Content-Security-Policy': "frame-ancestors 'self'" });
    }
    const q = url.searchParams;
    if (p === '/api/me' && req.method === 'GET') {
      const nas = roots().map((r) => ({ src: 'nas:' + r.label, kind: 'nas', label: r.label, mode: r.mode }));
      return json(res, 200, { user, sources: nas.concat(dav.list(user)) });
    }
    if (p === '/api/dav' && req.method === 'POST') return json(res, 200, await dav.add(user, await readJson(req)));
    if (p === '/api/dav' && req.method === 'DELETE') { dav.remove(user, String(q.get('id') || '')); return json(res, 200, { ok: true }); }
    const src = String(q.get('src') || '');
    const davId = src.startsWith('dav:') ? src.slice(4) : '';
    if (p === '/api/list' && req.method === 'GET') {
      if (davId) return json(res, 200, await dav.listDir(user, davId, q.get('dir')));
      return json(res, 200, await apiList(q));
    }
    if (p === '/api/file' && req.method === 'GET') {
      if (davId) { console.log(`[pdf] ${user} ouvre ${src}/${q.get('path')}`); return await dav.readFile(user, davId, String(q.get('path') || ''), res, MAX_PDF); }
      return await apiRead(req, res, q, user);
    }
    if (p === '/api/file' && req.method === 'PUT') {
      if (davId) {
        const name = path.basename(String(q.get('path') || ''));
        if (!isPdf(name) || hidden(name) || !/^[^/\\:*?"<>|\x00-\x1f]{1,255}$/.test(name)) throw fail('Nom de fichier invalide (il doit finir par .pdf).', 400);
        if (Number(req.headers['content-length'] || 0) > MAX_PDF) throw fail('Fichier trop gros (512 Mo au plus).', 413);
        const r = await dav.writeFile(user, davId, String(q.get('path')), req.pipe(pdfGuard()), { etag: q.get('etag') || '', overwrite: q.get('overwrite') === '1', headers: req.headers });
        console.log(`[pdf] ${user} enregistre ${src}/${q.get('path')}`);
        return json(res, 200, r);
      }
      return json(res, 200, await apiWrite(req, res, q, user));
    }
    return send(res, 404, 'Introuvable');
  } catch (e) {
    if (!e.status && (e.code === 'EACCES' || e.code === 'EPERM')) {
      e = fail('Le compte du NAS prêté à l’app n’a pas le droit d’ouvrir ce dossier. Choisissez dans Desktroo Apps un compte qui y a accès, ou un autre dossier.', 403);
    } else if (!e.status && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      e = fail('Introuvable : le fichier ou le dossier a peut-être été déplacé.', 404);
    }
    if (!e.status) console.error('[pdf]', e);
    if (res.headersSent) return res.destroy();
    return json(res, e.status || 500, { ok: false, error: e.status ? e.message : 'Erreur interne.' });
  }
});
server.requestTimeout = 0;   // gros PDF sur une connexion lente
server.listen(PORT, () => console.log(`[pdf] prêt sur ${PORT} — ${roots().length} dossier(s) du NAS`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)));
