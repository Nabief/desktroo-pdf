// Desktroo PDF — © 2026 Mdm-services.fr. Tous droits réservés.
// Connexions WebDAV de chaque utilisateur Desktroo : Nextcloud (dossier personnel et partages) ou WebDAV générique
// (Synology : paquet « WebDAV Server » de DSM, dossier home/Drive et Team Folders). Les fichiers passent par le
// serveur distant, qui tient lui-même versions, corbeille, droits et synchronisation des postes.
// Mots de passe d'application chiffrés (AES-256-GCM) avec une clé tirée du secret de l'installation.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA, 'connections.json');
const SECRET = process.env.DESKTROO_APP_SECRET || '';
const KEY = crypto.createHash('sha256').update('desktroo-pdf-dav-v1:' + SECRET).digest();
const MAX_XML = 8 * 1024 * 1024;
const MAX_PER_USER = 10;
const TIMEOUT = 30000;

function fail(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

// ── Stockage ─────────────────────────────────────────────────────────────────────────
function load() {
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); return d && typeof d === 'object' && d.users ? d : { users: {} }; }
  catch (_) { return { users: {} }; }
}
function save(d) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function unseal(b64) {
  const b = Buffer.from(String(b64 || ''), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
function list(user) { return (load().users[user] || []).map(publicView); }
function publicView(c) { return { src: 'dav:' + c.id, kind: c.kind, label: c.label, mode: 'rw', host: new URL(c.base).host, login: c.login }; }
function get(user, id) {
  const c = (load().users[user] || []).find((x) => x.id === id);
  if (!c) throw fail('Connexion inconnue : ajoutez-la à nouveau.', 404);
  return c;
}
function remove(user, id) {
  const d = load(); const arr = d.users[user] || [];
  const n = arr.filter((x) => x.id !== id);
  if (n.length === arr.length) throw fail('Connexion inconnue.', 404);
  d.users[user] = n; save(d);
}

// ── Adresse : pas de cible interne au réseau des apps (bureau, autres apps) ────────────────────────
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { throw fail('Adresse invalide : indiquez par exemple https://cloud.mondomaine.fr'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw fail('L’adresse doit commencer par https:// (ou http:// sur le réseau local).');
  if (u.username || u.password) throw fail('Mettez l’identifiant et le mot de passe dans leurs champs, pas dans l’adresse.');
  const h = u.hostname.toLowerCase();
  if (/^(localhost|fileops|desktroo[a-z0-9-]*|dt-[a-z0-9-]+)$/.test(h) || /^127\./.test(h) || h === '::1' || h === '[::1]' || h === '0.0.0.0') {
    throw fail('Cette adresse est réservée à Desktroo.');
  }
  u.hash = ''; u.search = '';
  return u;
}

// ── Requêtes ─────────────────────────────────────────────────────────────────────────
function request(conn, method, url, opts) {
  opts = opts || {};
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const headers = Object.assign({ 'User-Agent': 'DesktrooPDF/0.2' }, opts.headers || {});
  if (conn.login) headers.Authorization = 'Basic ' + Buffer.from(conn.login + ':' + conn.pass).toString('base64');
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers, rejectUnauthorized: !conn.insecure, timeout: TIMEOUT }, resolve);
    req.on('timeout', () => req.destroy(fail('Le serveur ne répond pas (délai dépassé).', 504)));
    req.on('error', (e) => reject(e.status ? e : netError(e)));
    if (opts.body && typeof opts.body.pipe === 'function') {
      opts.body.on('error', (e) => { req.destroy(); reject(e); });
      opts.body.pipe(req);
    }
    else req.end(opts.body);
  });
}
function netError(e) {
  const c = e.code || '';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(c)) return fail('Certificat du serveur refusé (' + c + '). Sur le réseau local, cochez « Certificat autosigné accepté ».', 502);
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return fail('Serveur introuvable : vérifiez l’adresse.', 502);
  if (c === 'ECONNREFUSED') return fail('Connexion refusée : vérifiez l’adresse et le port (Synology WebDAV : 5006 en https, 5005 en http).', 502);
  return fail('Serveur injoignable (' + (c || e.message) + ').', 502);
}
function readAll(res, max) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    res.on('data', (c) => { n += c.length; if (n > max) { res.destroy(); reject(fail('Réponse trop grosse.', 502)); } else parts.push(c); });
    res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    res.on('error', reject);
  });
}
function statusError(res, what) {
  const s = res.statusCode;
  res.resume();
  if (s === 401) return fail('Identifiant ou mot de passe refusé par le serveur.', 401);
  if (s === 403) return fail('Le serveur refuse l’accès' + (what ? ' à ' + what : '') + '.', 403);
  if (s === 404) return fail('Introuvable sur le serveur.', 404);
  if (s === 405 || s === 501) return fail('Cette adresse ne répond pas en WebDAV.', 502);
  if (s === 412) return fail('conflict', 412);
  if (s === 423) return fail('Fichier verrouillé sur le serveur (ouvert ailleurs ?).', 423);
  if (s === 507) return fail('Espace insuffisant sur le serveur.', 507);
  return fail('Le serveur a répondu ' + s + '.', 502);
}

// Chemin relatif → URL : chaque segment encodé, jamais de « .. ».
function fileUrl(conn, rel) {
  const segs = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.' || s.includes('\0'))) throw fail('Chemin refusé.', 400);
  return conn.base + segs.map(encodeURIComponent).join('/');
}

// ── PROPFIND : lecture tolérante des réponses multistatus (préfixes d'espace de noms variables) ─────────
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop>'
  + '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:getcontenttype/></d:prop></d:propfind>';
function tag(xml, name) {
  const m = new RegExp('<(?:[A-Za-z0-9_-]+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?' + name + '>', 'i').exec(xml);
  return m ? m[1] : null;
}
function xmlText(s) {
  return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').trim();
}
function parseMultistatus(xml) {
  const out = [];
  const re = /<(?:[A-Za-z0-9_-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?response>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const r = m[1];
    const href = xmlText(tag(r, 'href'));
    // propstat en 200 seulement (les propriétés absentes arrivent dans un propstat 404)
    let props = '';
    const ps = /<(?:[A-Za-z0-9_-]+:)?propstat(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?propstat>/gi;
    let p;
    while ((p = ps.exec(r))) { if (/\s200\s/.test(' ' + (tag(p[1], 'status') || '') + ' ')) props += p[1]; }
    if (!props) props = r;
    const rt = tag(props, 'resourcetype') || '';
    out.push({
      href,
      dir: /<(?:[A-Za-z0-9_-]+:)?collection\b/i.test(rt),
      size: Number(xmlText(tag(props, 'getcontentlength')) || 0),
      mtime: Date.parse(xmlText(tag(props, 'getlastmodified'))) || 0,
      etag: xmlText(tag(props, 'getetag')),
    });
  }
  return out;
}
async function propfind(conn, url, depth) {
  const res = await request(conn, 'PROPFIND', url, { headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY });
  if (res.statusCode !== 207) throw statusError(res);
  return parseMultistatus(await readAll(res, MAX_XML));
}

// ── Ajout d'une connexion : vérifiée avant d'être gardée ─────────────────────────────────────
async function add(user, body) {
  const d = load(); const arr = d.users[user] || [];
  if (arr.length >= MAX_PER_USER) throw fail('10 connexions au plus.');
  const kind = body.kind === 'nextcloud' ? 'nextcloud' : 'webdav';
  const u = checkUrl(body.url);
  const login = String(body.login || '').trim().slice(0, 200);
  const pass = String(body.pass || '');
  if (!login || !pass) throw fail('Indiquez l’identifiant et le mot de passe (de préférence un mot de passe d’application).');
  const conn = { login, pass, insecure: !!body.insecure };
  let base;
  if (kind === 'nextcloud') {
    // L'identifiant de connexion (souvent l'e-mail) n'est pas toujours l'identifiant du compte : on le demande à Nextcloud.
    const root = u.origin + u.pathname.replace(/\/+(index\.php.*)?$/, '');
    const res = await request(conn, 'GET', root + '/ocs/v2.php/cloud/user?format=json', { headers: { 'OCS-APIRequest': 'true', Accept: 'application/json' } });
    if (res.statusCode !== 200) {
      if (res.statusCode === 404) { res.resume(); throw fail('Pas de Nextcloud à cette adresse : indiquez l’adresse de la page de connexion de Nextcloud.', 400); }
      throw statusError(res);
    }
    let id = '';
    try { id = JSON.parse(await readAll(res, 1024 * 1024)).ocs.data.id; } catch (_) { id = ''; }
    if (!id) throw fail('Réponse inattendue de Nextcloud.', 502);
    base = root + '/remote.php/dav/files/' + encodeURIComponent(id) + '/';
  } else {
    base = u.origin + (u.pathname.endsWith('/') ? u.pathname : u.pathname + '/');
  }
  const c = { id: crypto.randomBytes(6).toString('hex'), kind, base, login, pass, insecure: conn.insecure };
  const items = await propfind(c, base, 0);
  if (!items.length || !items[0].dir) throw fail('Cette adresse ne mène pas à un dossier WebDAV.', 400);
  const label = String(body.label || '').trim().slice(0, 40) || (kind === 'nextcloud' ? 'Nextcloud' : u.hostname);
  arr.push({ id: c.id, kind, label, base, login, pass: seal(pass), insecure: c.insecure, at: Date.now() });
  d.users[user] = arr; save(d);
  return publicView(arr[arr.length - 1]);
}

function open(user, id) {
  const c = get(user, id);
  let pass;
  try { pass = unseal(c.pass); } catch (_) { throw fail('Connexion illisible (clé changée) : retirez-la et ajoutez-la à nouveau.', 409); }
  return Object.assign({}, c, { pass });
}

async function listDir(user, id, rel) {
  const c = open(user, id);
  const url = fileUrl(c, rel) + (rel ? '/' : '');
  const items = await propfind(c, url, 1);
  const basePath = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '');
  const out = [];
  for (const it of items) {
    let p;
    try { p = decodeURIComponent(new URL(it.href, url).pathname).replace(/\/+$/, ''); } catch (_) { continue; }
    if (p === basePath) continue;                         // le dossier lui-même
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (!name || name.startsWith('.') || name === '#recycle' || name === '@eaDir') continue;
    if (it.dir) out.push({ name, dir: true });
    else if (/\.pdf$/i.test(name)) out.push({ name, size: it.size, mtime: it.mtime });
  }
  out.sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true }));
  return { entries: out.slice(0, 2000), truncated: out.length > 2000 };
}

async function readFile(user, id, rel, res, maxBytes) {
  if (!/\.pdf$/i.test(rel)) throw fail('Seuls les fichiers PDF s’ouvrent ici.', 415);
  const c = open(user, id);
  const up = await request(c, 'GET', fileUrl(c, rel));
  if (up.statusCode !== 200) throw statusError(up, 'ce fichier');
  const len = Number(up.headers['content-length'] || 0);
  if (len > maxBytes) { up.destroy(); throw fail('Fichier trop gros (512 Mo au plus).', 413); }
  const h = { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Etag': String(up.headers.etag || '') };
  if (len) h['Content-Length'] = len;
  res.writeHead(200, h);
  let n = 0;
  up.on('data', (ch) => { n += ch.length; if (n > maxBytes) { up.destroy(); res.destroy(); } });
  up.pipe(res);
}

// Écriture : If-Match (le fichier n'a pas changé depuis son ouverture) ou If-None-Match: * (nouveau fichier).
async function writeFile(user, id, rel, req, opts) {
  const c = open(user, id);
  const headers = { 'Content-Type': 'application/pdf' };
  const cl = opts.headers && opts.headers['content-length'];
  if (cl) headers['Content-Length'] = cl;
  if (opts.etag) headers['If-Match'] = opts.etag;
  else if (!opts.overwrite) headers['If-None-Match'] = '*';
  const up = await request(c, 'PUT', fileUrl(c, rel), { headers, body: req });
  if (up.statusCode === 412) {
    up.resume();
    throw opts.etag ? fail('Ce fichier a été modifié par quelqu’un d’autre depuis son ouverture.', 412) : fail('Un fichier porte déjà ce nom.', 409);
  }
  if (up.statusCode < 200 || up.statusCode > 299) throw statusError(up, 'ce dossier');
  up.resume();
  return { ok: true, etag: String(up.headers.etag || ''), replaced: up.statusCode === 204 };
}

module.exports = { list, add, remove, listDir, readFile, writeFile, _parseMultistatus: parseMultistatus };
