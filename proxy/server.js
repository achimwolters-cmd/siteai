// Ailima Proxy Server – last deploy trigger: 2026-08-22
require('dotenv').config({ override: true });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;
const CLIENTS_FILE = path.join(__dirname, 'clients.json');

// Seed clients.json from CLIENTS_SEED env var if file doesn't exist
if (!fs.existsSync(CLIENTS_FILE) && process.env.CLIENTS_SEED) {
  try {
    fs.writeFileSync(CLIENTS_FILE, process.env.CLIENTS_SEED, 'utf8');
    console.log('[SiteAI] clients.json aus CLIENTS_SEED wiederhergestellt.');
  } catch (e) {
    console.error('[SiteAI] Fehler beim Seeden:', e.message);
  }
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Statische Demo-Seiten unter /demo/* ausliefern
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function loadClients() {
  if (!fs.existsSync(CLIENTS_FILE)) return {};
  return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
}

function saveClients(clients) {
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
}

function requireAdminKey(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------- public endpoints ----------

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Credit status for client
app.get('/api/status', (req, res) => {
  const token = req.headers['x-client-token'];
  if (!token) return res.status(400).json({ error: 'Missing x-client-token header' });

  const clients = loadClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  if (!client.active) return res.status(403).json({ error: 'Account deactivated' });

  res.json({
    name: client.name,
    credits: client.credits,
    created: client.created,
  });
});

// Main chat proxy
app.post('/api/chat', async (req, res) => {
  const token = req.headers['x-client-token'];
  if (!token) return res.status(400).json({ error: 'Missing x-client-token header' });

  const clients = loadClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  if (!client.active) return res.status(403).json({ error: 'Account deactivated' });
  if (client.credits <= 0) {
    return res.status(402).json({
      error: 'No credits remaining',
      credits: 0,
      message: 'Ihr Guthaben ist aufgebraucht. Bitte kaufen Sie weitere Anfragen nach.',
    });
  }

  const { messages, system, model } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing or invalid messages array' });
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-haiku-4-5',
        max_tokens: 512,
        system: system || '',
        messages,
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      console.error('Anthropic API error:', data);
      return res.status(anthropicRes.status).json({ error: data.error?.message || 'API error' });
    }

    // Deduct 1 credit
    clients[token].credits -= 1;
    clients[token].lastUsed = new Date().toISOString();
    saveClients(clients);

    res.json({
      ...data,
      _credits_remaining: clients[token].credits,
    });
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Proxy server error', details: err.message });
  }
});

// Save site HTML
app.post('/api/save', (req, res) => {
  const token = req.headers['x-client-token'];
  if (!token) return res.status(400).json({ error: 'Missing x-client-token header' });

  const clients = loadClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  if (!client.active) return res.status(403).json({ error: 'Account deactivated' });

  const { html, site } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Missing html' });
  }

  // Nur erlaubte Seiten (Sicherheit)
  const siteName = (site || 'demo').replace(/[^a-z0-9-]/g, '');
  if (siteName === 'demo') {
    return res.status(403).json({ error: 'Demo-Seite kann nicht gespeichert werden' });
  }
  const siteDir  = path.join(__dirname, 'public', siteName);
  if (!fs.existsSync(siteDir)) {
    return res.status(400).json({ error: 'Unknown site' });
  }

  try {
    const filePath = path.join(siteDir, 'index.html');

    // Aktuelle Version archivieren (max. 5 Versionen)
    const versionsDir = path.join(__dirname, 'public', 'versions');
    if (!fs.existsSync(versionsDir)) fs.mkdirSync(versionsDir, { recursive: true });

    if (fs.existsSync(filePath)) {
      const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
      const vFile = path.join(versionsDir, `${siteName}_${ts}.html`);
      fs.copyFileSync(filePath, vFile);

      // Nur letzte 5 behalten
      const allVersions = fs.readdirSync(versionsDir)
        .filter(f => f.startsWith(siteName + '_') && f.endsWith('.html'))
        .sort();
      while (allVersions.length > 5) {
        fs.unlinkSync(path.join(versionsDir, allVersions.shift()));
      }
    }

    fs.writeFileSync(filePath, html, 'utf8');
    console.log(`[SiteAI] "${siteName}" gespeichert von ${client.name}`);
    res.json({ ok: true, message: 'Seite gespeichert!' });
  } catch(err) {
    console.error('Save error:', err);
    res.status(500).json({ error: 'Speichern fehlgeschlagen', details: err.message });
  }
});

// GET /api/versions?site=demo  – Versionen auflisten
app.get('/api/versions', (req, res) => {
  const token = req.headers['x-client-token'];
  const clients = loadClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Invalid token' });

  const site = req.query.site || 'demo';
  const versionsDir = path.join(__dirname, 'public', 'versions');
  if (!fs.existsSync(versionsDir)) return res.json({ versions: [] });

  const versions = fs.readdirSync(versionsDir)
    .filter(f => f.startsWith(site + '_') && f.endsWith('.html'))
    .sort().reverse().slice(0, 5)
    .map(f => {
      const ts = f.replace(site + '_', '').replace('.html', '');
      // ts format: 2026-03-25T14-32-15  → lesbares Datum
      const [datePart, timePart] = ts.split('T');
      const [y, mo, d] = datePart.split('-');
      const [h, mi, s] = (timePart || '00-00-00').split('-');
      const label = `${d}.${mo}.${y} ${h}:${mi} Uhr`;
      return { filename: f, label };
    });

  res.json({ versions });
});

// POST /api/restore  – Version wiederherstellen
app.post('/api/restore', (req, res) => {
  const token = req.headers['x-client-token'];
  const clients = loadClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Invalid token' });

  const { filename, site } = req.body;
  if (!filename || filename.includes('..') || !filename.endsWith('.html')) {
    return res.status(400).json({ error: 'Ungültiger Dateiname' });
  }

  const versionsDir = path.join(__dirname, 'public', 'versions');
  const versionFile = path.join(versionsDir, filename);
  const siteName    = (site || 'demo').replace(/[^a-z0-9-]/g, '');
  const siteFile    = path.join(__dirname, 'public', siteName, 'index.html');

  if (!fs.existsSync(versionFile)) return res.status(404).json({ error: 'Version nicht gefunden' });

  // Aktuelle Version zuerst archivieren
  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  if (fs.existsSync(siteFile)) {
    fs.copyFileSync(siteFile, path.join(versionsDir, `${siteName}_${ts}.html`));
  }

  fs.copyFileSync(versionFile, siteFile);
  res.json({ ok: true, message: 'Version wiederhergestellt' });
});

// ══════════════════════════════════════════
// CRM – Akquise-Tool
// ══════════════════════════════════════════

const CRM_FILE = path.join(__dirname, 'crm.json');
const crypto = require('crypto');
const zlib = require('zlib');

const CRM_USERS = {
  silke: { name: 'Silke Wolters' },
  achim: { name: 'Achim Wolters' },
  emily: { name: 'Emily Wolters' },
  rene:  { name: 'René Meding'  },
};
const CRM_PASSWORD = process.env.CRM_PASSWORD || 'ailima2026';

// Seed crm.json from env var if not exists (supports gzip+base64 compressed seeds)
if (!fs.existsSync(CRM_FILE) && process.env.CRM_SEED) {
  try {
    let content = process.env.CRM_SEED;
    try {
      const buf = Buffer.from(content, 'base64');
      if (buf[0] === 0x1f && buf[1] === 0x8b) { // gzip magic bytes
        content = zlib.gunzipSync(buf).toString('utf8');
      }
    } catch(e) {} // not compressed, use raw
    fs.writeFileSync(CRM_FILE, content, 'utf8');
  } catch(e) {}
}

function loadCRM() {
  if (!fs.existsSync(CRM_FILE)) return { leads: [], sessions: {} };
  try { return JSON.parse(fs.readFileSync(CRM_FILE, 'utf8')); } catch(e) { return { leads: [], sessions: {} }; }
}
async function syncEnvVar(seed) {
  // Compress seed (gzip+base64) to minimize size
  const compressed = zlib.gzipSync(Buffer.from(seed, 'utf8')).toString('base64');

  // --- Render.com ---
  const RENDER_API_KEY    = process.env.RENDER_API_KEY;
  const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;
  if (RENDER_API_KEY && RENDER_SERVICE_ID) {
    const res = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RENDER_API_KEY}` },
      body: JSON.stringify([{ key: 'CRM_SEED', value: compressed }])
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Render API error ${res.status}: ${txt}`);
    }
    return true;
  }

  // --- Railway (legacy fallback) ---
  const RAILWAY_TOKEN          = process.env.RAILWAY_TOKEN;
  const RAILWAY_PROJECT_ID     = process.env.RAILWAY_PROJECT_ID;
  const RAILWAY_ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID;
  const RAILWAY_SERVICE_ID     = process.env.RAILWAY_SERVICE_ID;
  if (RAILWAY_TOKEN && RAILWAY_PROJECT_ID && RAILWAY_ENVIRONMENT_ID && RAILWAY_SERVICE_ID) {
    const res = await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RAILWAY_TOKEN}` },
      body: JSON.stringify({
        query: `mutation variableUpsert($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
        variables: { input: { projectId: RAILWAY_PROJECT_ID, environmentId: RAILWAY_ENVIRONMENT_ID, serviceId: RAILWAY_SERVICE_ID, name: 'CRM_SEED', value: compressed } }
      })
    });
    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return true;
  }

  // No sync configured – skip silently
  return true;
}

async function saveCRM(data) {
  // Only write to local filesystem – Railway sync only happens via /crm/forcesync
  // to avoid triggering Railway auto-redeploys on every save
  fs.writeFileSync(CRM_FILE, JSON.stringify(data, null, 2));
  console.log(`[CRM] saved locally – ${data.leads.length} Leads`);
  scheduleCRMUpload();
}

// Render's disk is wiped on every restart, so the CRM is mirrored to the private FTP folder.
// Only on Render: a local dev server must never overwrite the production copy.
const CRM_REMOTE_DIR = 'ailima-data';
const CRM_FTP_ENABLED = !!process.env.RENDER && !!process.env.FTP_PASS;
let crmFtpWritable = false;
let crmReady = Promise.resolve();
let crmUploadTimer = null;

async function restoreCRMFromFtp() {
  if (!CRM_FTP_ENABLED) return;
  setupFtpNetrc();
  const tmp = '/tmp/crm-remote.json';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await run(`curl --netrc-file "${NETRC_FILE}" -sS --fail -o "${tmp}" "ftp://${FTP_HOST}/${CRM_REMOTE_DIR}/crm.json"`, 30000);
      const data = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      if (!Array.isArray(data.leads)) throw new Error('ungültige CRM-Datei');
      fs.writeFileSync(CRM_FILE, JSON.stringify(data, null, 2));
      crmFtpWritable = true;
      console.log(`[CRM] aus FTP wiederhergestellt – ${data.leads.length} Leads`);
      return;
    } catch (e) {
      if (/\(78\)|550/.test(e.message)) {
        crmFtpWritable = true;
        console.log('[CRM] noch keine FTP-Kopie – starte mit CRM_SEED');
        scheduleCRMUpload();
        return;
      }
      console.error(`[CRM] FTP-Wiederherstellung Versuch ${attempt}:`, e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  // Uploading now could overwrite newer data with the stale seed.
  console.error('[CRM] FTP nicht erreichbar – FTP-Sicherung für diese Laufzeit deaktiviert');
}

function scheduleCRMUpload() {
  if (!crmFtpWritable) return;
  clearTimeout(crmUploadTimer);
  crmUploadTimer = setTimeout(async () => {
    const tmp = '/tmp/crm-upload.json';
    try {
      fs.copyFileSync(CRM_FILE, tmp);
      await run(`curl --netrc-file "${NETRC_FILE}" -sS -T "${tmp}" "ftp://${FTP_HOST}/${CRM_REMOTE_DIR}/crm.json.tmp" -Q "-RNFR crm.json.tmp" -Q "-RNTO crm.json"`, 30000);
      console.log('[CRM] FTP-Sicherung aktualisiert');
    } catch (e) {
      console.error('[CRM] FTP-Sicherung fehlgeschlagen:', e.message);
    }
  }, 1500);
}

// Force-sync current crm.json state to hosting env var (Render or Railway)
app.post('/crm/forcesync', requireCRM, async (req, res) => {
  try {
    const data = loadCRM();
    const seed = JSON.stringify({ leads: data.leads, sessions: {} });
    await syncEnvVar(seed);
    console.log(`[CRM] force-sync OK – ${data.leads.length} Leads`);
    res.json({ ok: true, leads: data.leads.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
// Stateless HMAC tokens – survive server restarts
const CRM_SECRET = process.env.CRM_SECRET || 'ailima-crm-secret-2026';
const TOKEN_TTL  = 30 * 24 * 60 * 60 * 1000; // 30 days

function signToken(user) {
  const expires = Date.now() + TOKEN_TTL;
  const payload = `${user}:${expires}`;
  const sig = crypto.createHmac('sha256', CRM_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}
function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    const [user, expires, sig] = decoded.split(':');
    if (Date.now() > parseInt(expires)) return null;
    const expected = crypto.createHmac('sha256', CRM_SECRET).update(`${user}:${expires}`).digest('hex');
    if (sig !== expected) return null;
    return CRM_USERS[user] ? { user, name: CRM_USERS[user].name } : null;
  } catch { return null; }
}

function requireCRM(req, res, next) {
  const session = verifyToken(req.headers['x-crm-token'] || '');
  if (!session) return res.status(401).json({ error: 'Nicht eingeloggt' });
  req.crmUser = session.user;
  req.crmName = session.name;
  crmReady.then(() => next());
}

// Login
app.post('/crm/login', (req, res) => {
  const { user, password } = req.body;
  if (!CRM_USERS[user] || password !== CRM_PASSWORD) {
    return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });
  }
  res.json({ token: signToken(user), name: CRM_USERS[user].name, user });
});

// Logout (client just drops the token)
app.post('/crm/logout', (req, res) => res.json({ ok: true }));

// Get all leads
app.get('/crm/leads', requireCRM, (req, res) => {
  const data = loadCRM();
  res.json({ leads: data.leads || [], users: CRM_USERS });
});

// Create lead
app.post('/crm/leads', requireCRM, async (req, res) => {
  try {
    const data = loadCRM();
    const lead = {
      id: crypto.randomBytes(8).toString('hex'),
      ...req.body,
      createdBy: req.crmUser,
      createdByName: req.crmName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: req.crmUser,
    };
    data.leads.unshift(lead);
    await saveCRM(data);
    res.json({ lead });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Update lead
app.put('/crm/leads/:id', requireCRM, async (req, res) => {
  try {
    const data = loadCRM();
    const idx = data.leads.findIndex(l => l.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Nicht gefunden' });
    data.leads[idx] = {
      ...data.leads[idx],
      ...req.body,
      id: req.params.id,
      updatedAt: new Date().toISOString(),
      updatedBy: req.crmUser,
      updatedByName: req.crmName,
    };
    await saveCRM(data);
    res.json({ lead: data.leads[idx] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete lead
app.delete('/crm/leads/:id', requireCRM, async (req, res) => {
  try {
    const data = loadCRM();
    data.leads = data.leads.filter(l => l.id !== req.params.id);
    await saveCRM(data);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/crm/leads/archive', requireCRM, async (req, res) => {
  try {
    const ids = new Set(req.body.ids || []);
    const archived = req.body.archived !== false;
    const data = loadCRM();
    const now = new Date().toISOString();
    let updated = 0;
    for (const l of data.leads) {
      if (!ids.has(l.id)) continue;
      l.archived = archived;
      l.updatedAt = now;
      l.updatedBy = req.crmUser;
      updated++;
    }
    await saveCRM(data);
    res.json({ updated });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Export CRM seed (for Railway CRM_SEED env var)
app.get('/crm/backup', requireCRM, (req, res) => {
  const data = loadCRM();
  const seed = JSON.stringify({ leads: data.leads, sessions: {} });
  res.json({ seed });
});

// ── CRM: Mail-System ─────────────────────────────────────────
const nodemailer = require('nodemailer');
const SMTP_HOST      = process.env.SMTP_HOST || 'tojopo.han-solo.net';
const SMTP_PORT      = parseInt(process.env.SMTP_PORT) || 587;
const SMTP_USER      = process.env.SMTP_USER || 'achim@ailima.de';
const SMTP_PASS      = process.env.SMTP_PASS || '';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'Achim Wolters';

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const DEMO_URL = 'https://siteai-khmo.onrender.com/demo/?edit=sat_4ug6sat368k4ew976lr8z';

function buildMail(body) {
  const plain = body.trim().replace(/\*\*(.+?)\*\*/g, '$1');
  const text = `${plain}\n\nLive-Demo ausprobieren: ${DEMO_URL}\n\nViele Grüße\n${SMTP_FROM_NAME}\n\n--\nAilima – Ihre Website. Einfach selbst ändern.\nwww.ailima.de · ${SMTP_USER}\nImpressum: https://www.ailima.de/impressum.html\n\nKein Interesse? Eine kurze Antwort genügt, dann melde ich mich nicht wieder.`;
  const paragraphs = body.trim().split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 14px">${escHtml(p).replace(/\n/g, '<br>')
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#0f2229">$1</strong>')}</p>`).join('');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a2a2e;max-width:600px">
${paragraphs}
<table cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px"><tr>
  <td style="background:#3d8a96;border-radius:8px">
    <a href="${DEMO_URL}" style="display:inline-block;padding:11px 22px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none">&#9654; Live-Demo ausprobieren</a>
  </td>
</tr></table>
<p style="margin:0 0 22px">Viele Grüße<br>${escHtml(SMTP_FROM_NAME)}</p>
<table cellpadding="0" cellspacing="0" border="0" style="border-top:3px solid #3d8a96;padding-top:14px;margin-top:4px">
  <tr>
    <td style="padding:14px 16px 0 0;vertical-align:top"><img src="cid:ailima-logo" width="44" height="60" alt="Ailima" style="display:block;border:0"></td>
    <td style="padding-top:14px;vertical-align:top;font-size:13px;line-height:1.55;color:#4a6b72">
      <div style="font-size:15px;font-weight:700;color:#0f2229">${escHtml(SMTP_FROM_NAME)}</div>
      <div style="font-size:15px;font-weight:800;color:#0f2229;margin-top:2px">Ai<span style="color:#3d8a96">lima</span></div>
      <div>Ihre Website. Einfach selbst ändern – per KI-Assistent.</div>
      <div style="margin-top:6px"><a href="https://www.ailima.de" style="color:#3d8a96;text-decoration:none;font-weight:600">www.ailima.de</a>
        &nbsp;·&nbsp; <a href="mailto:${SMTP_USER}" style="color:#3d8a96;text-decoration:none">${SMTP_USER}</a></div>
    </td>
  </tr>
</table>
<p style="margin:22px 0 0;font-size:11px;line-height:1.5;color:#94a3b8">Kein Interesse? Eine kurze Antwort genügt, dann melde ich mich nicht wieder. ·
<a href="https://www.ailima.de/impressum.html" style="color:#94a3b8">Impressum</a></p>
</div></body></html>`;
  return {
    text,
    html,
    attachments: [{ filename: 'ailima.png', path: path.join(__dirname, 'public', 'eddi.png'), cid: 'ailima-logo' }],
  };
}

app.post('/crm/preview-email', requireCRM, (req, res) => {
  const { html } = buildMail(String(req.body.body || ''));
  res.json({ html: html.replace('cid:ailima-logo', '/eddi.png') });
});

function smtpTransport() {
  return nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false },
  });
}

// SMTP health-check endpoint (used by CRM UI)
app.get('/crm/smtp-status', requireCRM, (req, res) => {
  res.json({ configured: !!SMTP_PASS, host: SMTP_HOST, user: SMTP_USER });
});

// OSM discovery: find local businesses via Overpass API
const OSM_UA = 'AilimaCRM/1.0 (achim@ailima.de)';
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function overpassOnce(url, query, signal) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': OSM_UA },
    body: 'data=' + encodeURIComponent(query),
    signal,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (!Array.isArray(data.elements)) throw new Error('ungültige Antwort');
  if (data.remark && data.elements.length === 0) throw new Error('Server-Timeout');
  return data;
}

// Mirrors are often queued for 30s+, so race them in parallel and take the first success.
async function overpassQuery(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75000);
  try {
    return await Promise.any(OVERPASS_MIRRORS.map(u => overpassOnce(u, query, controller.signal)));
  } catch (e) {
    const reasons = (e.errors || [e]).map(x => x.name === 'AbortError' ? 'Timeout' : x.message);
    console.error('[Overpass] alle Mirror fehlgeschlagen:', reasons);
    throw new Error('OpenStreetMap ist gerade überlastet – bitte in 1–2 Minuten erneut versuchen (' + reasons.join(', ') + ')');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function geocodeCity(city, country) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&city=${encodeURIComponent(city)}&countrycodes=${country}`;
  const r = await fetch(url, { headers: { 'User-Agent': OSM_UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Geocoding HTTP ${r.status}`);
  const [hit] = await r.json();
  if (!hit) return null;
  const [s, n, w, e] = hit.boundingbox.map(Number);
  return { bbox: `${s},${w},${n},${e}`, name: hit.name };
}

app.post('/crm/discover', requireCRM, async (req, res) => {
  const { city = 'Mönchengladbach', country = 'de', industry = 'Friseur / Kosmetik', limit = 30, customSearch = '' } = req.body;
  const countryCode = ['de', 'at', 'ch'].includes(country) ? country : 'de';
  const max = Math.max(1, Math.min(parseInt(limit) || 20, 100));

  const OSM_TAGS = {
    'Friseur / Kosmetik':       [['shop','hairdresser'],['shop','beauty'],['shop','cosmetics']],
    'Restaurant / Café':        [['amenity','restaurant'],['amenity','cafe'],['amenity','bar']],
    'Handwerk':                 [['craft','plumber'],['craft','electrician'],['craft','carpenter'],['craft','painter']],
    'Physiotherapie / Wellness':[['amenity','physiotherapist'],['healthcare','physiotherapist'],['shop','massage'],['leisure','spa']],
    'Kanzlei / Beratung':       [['office','lawyer'],['office','accountant'],['office','insurance']],
    'Einzelhandel':             [['shop','clothes'],['shop','florist'],['shop','furniture'],['shop','gift']],
    'Hotel / Pension':          [['tourism','hotel'],['tourism','guest_house'],['tourism','hostel']],
    'Fitness':                  [['leisure','fitness_centre'],['leisure','sports_centre']],
    'Zahnarzt':                 [['amenity','dentist']],
    'Arzt / Praxis':            [['amenity','doctors'],['healthcare','doctor'],['healthcare','clinic']],
    'Apotheke':                 [['amenity','pharmacy']],
    'Autowerkstatt':            [['shop','car_repair'],['craft','car_repair']],
    'Autohaus':                 [['shop','car']],
    'Reinigung':                [['shop','dry_cleaning'],['shop','laundry']],
    'Optiker':                  [['shop','optician']],
    'Bäckerei':                 [['shop','bakery']],
    'Immobilien':               [['office','estate_agent']],
  };

  const trimmed = customSearch.trim();
  let tagLines;
  if (trimmed) {
    const safe = trimmed.replace(/["\\]/g, '');
    tagLines = `  nwr["name"~"${safe}",i];`;
  } else {
    const tags = OSM_TAGS[industry] || [['amenity','restaurant']];
    tagLines = tags.map(([k,v]) => `  nwr["${k}"="${v}"];`).join('\n');
  }

  try {
    const place = await geocodeCity(city.trim(), countryCode);
    if (!place) return res.status(404).json({ error: `Stadt "${city}" in ${countryCode.toUpperCase()} nicht gefunden` });

    const query = `[out:json][timeout:60][bbox:${place.bbox}];
(
${tagLines}
);
out center tags ${Math.min(max * 4, 300)};`;

    const data = await overpassQuery(query);

    const crm = loadCRM();
    const existingNames  = new Set(crm.leads.map(l => (l.company||'').toLowerCase().replace(/[^a-z0-9]/g,'')));
    const existingEmails = new Set(crm.leads.map(l => (l.email||'').toLowerCase()).filter(Boolean));

    const results = (data.elements || [])
      .filter(el => el.tags?.name)
      .map(el => ({
        company:  el.tags.name,
        industry,
        city,
        phone:    el.tags.phone || el.tags['contact:phone'] || el.tags['phone:mobile'] || '',
        website:  el.tags.website || el.tags['contact:website'] || '',
        email:    el.tags.email || el.tags['contact:email'] || '',
        address:  [el.tags['addr:street'], el.tags['addr:housenumber']].filter(Boolean).join(' '),
      }))
      .filter(b => {
        const norm = b.company.toLowerCase().replace(/[^a-z0-9]/g,'');
        if (existingNames.has(norm)) return false;
        if (b.email && existingEmails.has(b.email.toLowerCase())) return false;
        return true;
      })
      .slice(0, max);

    res.json({ leads: results, total: data.elements?.length || 0 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate AI email for a lead
app.post('/crm/generate-email/:id', requireCRM, async (req, res) => {
  try {
    const data = loadCRM();
    const idx = data.leads.findIndex(l => l.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Lead nicht gefunden' });
    const lead = data.leads[idx];

    const subjects = [
      `Ihre Website – selbst aktualisieren, ganz ohne Programmierer`,
      `Öffnungszeiten, Preise, Aktionen – sofort selbst anpassen`,
      `Website aktuell halten ohne Agentur – für ${lead.company}`,
      `Kleine Website-Änderungen – jetzt in Sekunden, nicht Tagen`,
    ];
    const subject = subjects[Math.floor(Math.random() * subjects.length)];

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 700,
        system: `Du schreibst professionelle deutsche Kaltakquise-Mails für Ailima.

Was ist Ailima: Ein KI-Assistent, der direkt auf der Website des Kunden läuft. Der Unternehmer tippt einfach auf Deutsch, was geändert werden soll – Ailima setzt es um. Kein Programmierer, keine Agentur, kein Warten. Ab €29/Monat. Website: www.ailima.de

REGELN:
- Immer Sie-Form, natürliche Geschäftssprache
- Ansprechpartner falls bekannt namentlich ansprechen, sonst: "Guten Tag,"
- Maximal 160 Wörter
- Konkretes Problem der Branche ansprechen (z.B. Friseur: Öffnungszeiten, Preise, Mitarbeiter ändern sich)
- Ailima als Lösung nennen mit www.ailima.de
- Ab €29/Monat erwähnen
- CTA: kurzes 15-Minuten Telefonat oder Demo
- Markiere genau EINEN Kernsatz (den Nutzen von Ailima) mit **doppelten Sternchen**, sonst keine Formatierung
- Keine URL im Text – ein Demo-Button wird automatisch eingefügt; ende mit einer kurzen Frage
- NUR den E-Mail-Text ab der Anrede, keine Betreffzeile, keine Grußformel am Ende, keine Signatur`,
        messages: [{ role: 'user', content:
          `Firma: ${lead.company}\nBranche: ${lead.industry||'lokales Unternehmen'}\nStadt: ${lead.city||''}\nAnsprechpartner: ${lead.contact||'unbekannt'}\nWebsite: ${lead.website||'keine'}` }],
      }),
    });
    const cData = await claudeRes.json();
    if (!claudeRes.ok) throw new Error(cData.error?.message);

    const body = (cData.content?.[0]?.text || '').trim();
    const draft = { subject, body, generatedAt: new Date().toISOString() };

    data.leads[idx] = { ...lead, emailDraft: draft, mailStatus: 'draft',
      updatedAt: new Date().toISOString(), updatedBy: req.crmUser, updatedByName: req.crmName };
    await saveCRM(data);
    res.json({ draft, lead: data.leads[idx] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Send approved email via SMTP
app.post('/crm/send-email/:id', requireCRM, async (req, res) => {
  if (!SMTP_PASS) return res.status(500).json({ error: 'SMTP_PASS nicht in Render konfiguriert' });
  try {
    const data = loadCRM();
    const idx = data.leads.findIndex(l => l.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Lead nicht gefunden' });
    const lead = data.leads[idx];
    if (!lead.email) return res.status(400).json({ error: 'Keine E-Mail-Adresse eingetragen' });

    const { subject, body } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'Betreff und Text erforderlich' });


    await smtpTransport().sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_USER}>`,
      to: lead.email,
      subject,
      ...buildMail(body),
    });

    const now = new Date().toISOString();
    data.leads[idx] = { ...lead,
      status: 'angeschrieben', mailStatus: 'sent',
      emailSentAt: now, emailSubject: subject,
      followUp: new Date(Date.now() + 7*86400000).toISOString().slice(0,10),
      channel: 'email',
      updatedAt: now, updatedBy: req.crmUser, updatedByName: req.crmName,
    };
    await saveCRM(data);
    res.json({ ok: true, lead: data.leads[idx] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Send follow-up email
app.post('/crm/followup/:id', requireCRM, async (req, res) => {
  if (!SMTP_PASS) return res.status(500).json({ error: 'SMTP_PASS nicht in Render konfiguriert' });
  try {
    const data = loadCRM();
    const idx = data.leads.findIndex(l => l.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Lead nicht gefunden' });
    const lead = data.leads[idx];
    if (!lead.email)       return res.status(400).json({ error: 'Keine E-Mail-Adresse' });
    if (!lead.emailSentAt) return res.status(400).json({ error: 'Erste Mail noch nicht gesendet' });
    if (lead.followUp2SentAt) return res.status(400).json({ error: 'Follow-up 2 bereits gesendet – Sequenz abgeschlossen' });

    const isFU2 = !!lead.followUp1SentAt;
    const sentDE = new Date(lead.emailSentAt).toLocaleDateString('de-DE');

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 350,
        system: `Du schreibst ${isFU2 ? 'letzte Abschluss-' : 'freundliche Follow-up-'}Mails für Ailima (KI-Website-Editor, www.ailima.de, ab €29/Monat).
Kurz und respektvoll. Maximal ${isFU2 ? 80 : 110} Wörter. NUR E-Mail-Text ab der Anrede, keine Betreffzeile, keine Grußformel am Ende, keine Signatur.`,
        messages: [{ role: 'user', content: isFU2
          ? `Letzte höfliche Abschlussnachricht an ${lead.company} (${lead.industry||''}). Haben auf 2 Mails nicht geantwortet. Tür offen lassen für die Zukunft. Kein Verkaufsdruck.`
          : `Follow-up an ${lead.company} (${lead.industry||''}). Erste Mail: ${sentDE}. Keine Antwort. Neuen Gedanken einbringen: Website ist oft das erste was Kunden sehen – veraltete Infos kosten Vertrauen.` }],
      }),
    });
    const cData = await claudeRes.json();
    const body = (cData.content?.[0]?.text || '').trim();
    const origSubject = lead.emailSubject || `Ihre Website – selbst aktualisieren, ganz ohne Programmierer`;
    const subject = isFU2 ? `Letzte Nachricht von Ailima – ${origSubject}` : `Re: ${origSubject}`;

    await smtpTransport().sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_USER}>`,
      to: lead.email,
      subject,
      ...buildMail(body),
    });

    const now = new Date().toISOString();
    const fuKey = isFU2 ? 'followUp2SentAt' : 'followUp1SentAt';
    data.leads[idx] = { ...lead,
      [fuKey]: now,
      mailStatus: isFU2 ? 'fu2_sent' : 'fu1_sent',
      followUp: isFU2 ? '' : new Date(Date.now() + 7*86400000).toISOString().slice(0,10),
      updatedAt: now, updatedBy: req.crmUser, updatedByName: req.crmName,
    };
    await saveCRM(data);
    res.json({ ok: true, fuType: isFU2 ? 2 : 1, lead: data.leads[idx] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CRM: Lead-Pool (vorab gesammelte Firmen, liegt privat auf dem FTP) ──
const POOL_LOCAL = '/tmp/lead-pool.json';
let leadPool = null;

async function loadPool(force = false) {
  if (leadPool && !force) return leadPool;
  setupFtpNetrc();
  await run(`curl --netrc-file "${NETRC_FILE}" -sS -o "${POOL_LOCAL}" "ftp://${FTP_HOST}/ailima-data/lead-pool.json"`, 60000);
  leadPool = JSON.parse(fs.readFileSync(POOL_LOCAL, 'utf8'));
  return leadPool;
}

const normName = s => (s || '').toLowerCase().replace(/\b(gmbh|ug|ag|kg|ohg|gbr|e\.k\.|e\.v\.)\b/g, '').replace(/[^a-z0-9äöüß]/g, '');
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function crmIndex() {
  const leads = loadCRM().leads;
  return {
    ids:    new Set(leads.map(l => l.osmId).filter(Boolean)),
    names:  new Set(leads.map(l => normName(l.company)).filter(Boolean)),
    emails: new Set(leads.map(l => (l.email || '').toLowerCase()).filter(Boolean)),
    hosts:  new Set(leads.map(l => hostOf(l.website)).filter(Boolean)),
  };
}

const inCRM = (p, idx) =>
  idx.ids.has(p.osmId) || idx.names.has(normName(p.company)) ||
  (p.email && idx.emails.has(p.email)) || (p.website && idx.hosts.has(hostOf(p.website)));

app.get('/crm/pool', requireCRM, async (req, res) => {
  try {
    const pool = await loadPool(req.query.reload === '1');
    const idx = crmIndex();
    const industries = {};
    const cities = {};
    for (const p of pool.leads) {
      const i = industries[p.industry] ||= { total: 0, withEmail: 0, available: 0 };
      i.total++;
      if (p.email) i.withEmail++;
      if (p.email && !inCRM(p, idx)) i.available++;
      if (p.city) cities[p.city] = (cities[p.city] || 0) + 1;
    }
    const topCities = Object.entries(cities).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([c]) => c);
    res.json({ region: pool.region, updatedAt: pool.updatedAt, industries, cities: topCities });
  } catch (e) {
    res.status(500).json({ error: 'Lead-Pool nicht verfügbar: ' + e.message });
  }
});

app.post('/crm/pool/search', requireCRM, async (req, res) => {
  try {
    const { industry = '', city = '', q = '', onlyEmail = true, limit = 50 } = req.body;
    const pool = await loadPool();
    const idx = crmIndex();
    const needle = q.trim().toLowerCase();
    const cityNeedle = city.trim().toLowerCase();
    const matches = pool.leads.filter(p =>
      (!industry || p.industry === industry) &&
      (!onlyEmail || p.email) &&
      (!cityNeedle || (p.city || '').toLowerCase().includes(cityNeedle) || (p.postcode || '').startsWith(cityNeedle)) &&
      (!needle || `${p.company} ${p.street} ${p.website}`.toLowerCase().includes(needle)) &&
      !inCRM(p, idx)
    );
    const max = Math.max(1, Math.min(parseInt(limit) || 50, 500));
    res.json({ leads: matches.slice(0, max), total: matches.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/crm/pool/import', requireCRM, async (req, res) => {
  try {
    const ids = new Set(req.body.osmIds || []);
    const pool = await loadPool();
    const data = loadCRM();
    const idx = crmIndex();
    const now = new Date().toISOString();
    const added = [];
    for (const p of pool.leads) {
      if (!ids.has(p.osmId) || inCRM(p, idx)) continue;
      const lead = {
        id: crypto.randomBytes(8).toString('hex'),
        osmId: p.osmId, company: p.company, industry: p.industry,
        email: p.email, phone: p.phone, website: p.website,
        address: [p.street, [p.postcode, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        city: p.city, status: 'neu', channel: 'email', notes: '',
        createdBy: req.crmUser, createdByName: req.crmName, createdAt: now,
        updatedAt: now, updatedBy: req.crmUser,
      };
      idx.ids.add(p.osmId);
      idx.names.add(normName(p.company));
      data.leads.unshift(lead);
      added.push(lead);
    }
    await saveCRM(data);
    res.json({ added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- admin endpoints ----------

// List all clients
app.get('/admin/clients', requireAdminKey, (req, res) => {
  const clients = loadClients();
  res.json(clients);
});

// Create a new client
app.post('/admin/clients', requireAdminKey, (req, res) => {
  const { name, credits } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });

  const token = 'sat_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const clients = loadClients();

  clients[token] = {
    name,
    credits: credits ?? 30,
    active: true,
    created: new Date().toISOString(),
    lastUsed: null,
  };

  saveClients(clients);
  res.json({ token, ...clients[token] });
});

// Update credits
app.post('/admin/clients/:token/credits', requireAdminKey, (req, res) => {
  const { token } = req.params;
  const { amount } = req.body;
  if (typeof amount !== 'number') return res.status(400).json({ error: 'Missing amount (number)' });

  const clients = loadClients();
  if (!clients[token]) return res.status(404).json({ error: 'Client not found' });

  clients[token].credits += amount;
  saveClients(clients);
  res.json({ token, credits: clients[token].credits });
});

// Enable client
app.post('/admin/clients/:token/enable', requireAdminKey, (req, res) => {
  const clients = loadClients();
  if (!clients[req.params.token]) return res.status(404).json({ error: 'Client not found' });
  clients[req.params.token].active = true;
  saveClients(clients);
  res.json({ ok: true });
});

// Disable client
app.post('/admin/clients/:token/disable', requireAdminKey, (req, res) => {
  const clients = loadClients();
  if (!clients[req.params.token]) return res.status(404).json({ error: 'Client not found' });
  clients[req.params.token].active = false;
  saveClients(clients);
  res.json({ ok: true });
});

// Delete client
app.delete('/admin/clients/:token', requireAdminKey, (req, res) => {
  const clients = loadClients();
  if (!clients[req.params.token]) return res.status(404).json({ error: 'Client not found' });
  delete clients[req.params.token];
  saveClients(clients);
  res.json({ ok: true });
});

// ── BILD-UPLOAD ─────────────────────────────────────────────────────────────

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const site = (req.headers['x-site'] || '').replace(/[^a-z0-9-]/g, '');
      const dir = site
        ? path.join(__dirname, 'public', site, 'images')
        : path.join(__dirname, 'public', 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Nur Bilddateien erlaubt'));
  }
});

// POST /api/upload  – Bild hochladen, URL zurückgeben
app.post('/api/upload', imageUpload.single('image'), (req, res) => {
  const token = req.headers['x-client-token'];
  const clients = loadClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  if (!client.active) return res.status(403).json({ error: 'Account deactivated' });
  if (!req.file) return res.status(400).json({ error: 'Kein Bild empfangen' });

  const site = (req.headers['x-site'] || '').replace(/[^a-z0-9-]/g, '');
  const url  = site
    ? `/${site}/images/${req.file.filename}`
    : `/uploads/${req.file.filename}`;

  console.log(`[SiteAI] Bild hochgeladen: ${url} von ${client.name}`);
  res.json({ ok: true, url, filename: req.file.filename });
});

// ── NEUE SEITE ERSTELLEN ─────────────────────────────────────────────────────

// POST /api/create-page – neue Unterseite generieren + speichern
app.post('/api/create-page', async (req, res) => {
  const token = req.headers['x-client-token'];
  const clients = loadClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  if (!client.active) return res.status(403).json({ error: 'Account deactivated' });
  if (client.credits < 5) return res.status(402).json({
    error: 'Mindestens 5 Credits für Seitenerstellung benötigt.',
    credits: client.credits
  });

  const { pageContext, pageName, navLabel, headline, text, imageUrls, description, site } = req.body;
  const siteName  = (site || '').replace(/[^a-z0-9-]/g, '');
  const safeSlug  = (pageName || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0, 40);

  // Demo temporär freigeschaltet zum Testen
  // if (!siteName || siteName === 'demo') return res.status(403).json({ error: 'Nicht für Demo erlaubt' });
  if (!safeSlug) return res.status(400).json({ error: 'Ungültiger Seitenname' });

  const siteDir = path.join(__dirname, 'public', siteName);
  if (!fs.existsSync(siteDir)) return res.status(400).json({ error: 'Unbekannte Site' });

  try {
    // Claude generiert die neue Seite anhand des bestehenden Designs
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 8000,
        system: `Du bist ein professioneller Webdesigner. Du erstellst neue HTML-Seiten die zum bestehenden Design einer Website passen.
Analysiere das gegebene Design (CSS-Variablen, Farben, Schriften, Nav, Footer) und erstelle eine vollständige, passende HTML-Seite.
Die neue Seite muss:
- Dieselben CSS-Variablen, Schriften und Klassen nutzen
- Denselben <nav> (mit angepassten Links) und <footer> enthalten
- Mobilfreundlich sein
- Relevanten, professionellen Inhalt für das angegebene Thema haben
- Vollständiges, valides HTML sein (kein Markdown, keine Codeblöcke)
Antworte NUR mit dem vollständigen HTML. Keine Erklärung, kein Markdown.`,
        messages: [{
          role: 'user',
          content: `Erstelle eine neue Seite mit folgenden Angaben:
Menübezeichnung: ${navLabel || safeSlug}
URL: /${safeSlug}/
Überschrift der Seite: ${headline || navLabel || safeSlug}
Seitentext / Inhalt: ${text || description || navLabel || safeSlug}
${(imageUrls && imageUrls.length) ? `Fotos (binde alle als <img>-Elemente ein):\n${imageUrls.map(u => `- ${u}`).join('\n')}` : ''}

Design der bestehenden Website (übernimm Nav, Footer und CSS-Variablen exakt):
${pageContext || ''}`.slice(0, 60000)
        }]
      })
    });

    const cData = await claudeRes.json();
    if (!claudeRes.ok) throw new Error(cData.error?.message || 'Claude API Fehler');

    let html = (cData.content?.[0]?.text || '').trim()
      .replace(/^```html\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    if (!html.includes('<!DOCTYPE') && !html.includes('<html')) {
      throw new Error('Kein gültiges HTML erhalten');
    }

    // Neue Seite speichern
    const pageDir  = path.join(siteDir, safeSlug);
    const pagePath = path.join(pageDir, 'index.html');
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(pagePath, html, 'utf8');

    // Nav in index.html aktualisieren – Link vor nav-cta einfügen
    const indexPath = path.join(siteDir, 'index.html');
    if (navLabel && fs.existsSync(indexPath)) {
      let idx = fs.readFileSync(indexPath, 'utf8');
      const linkHtml = `<a href="${safeSlug}/">${navLabel}</a>`;
      if (!idx.includes(`href="${safeSlug}/"`)) {
        idx = idx.replace(
          /(<a[^>]+class="[^"]*nav-cta[^"]*")/,
          `${linkHtml}\n      $1`
        );
        fs.writeFileSync(indexPath, idx, 'utf8');
      }
    }

    // 5 Credits abziehen
    clients[token].credits -= 5;
    clients[token].lastUsed = new Date().toISOString();
    saveClients(clients);

    console.log(`[SiteAI] Neue Seite "/${safeSlug}/" erstellt für ${client.name}`);
    res.json({
      ok: true,
      url: `/${siteName}/${safeSlug}/`,
      pageName: safeSlug,
      navLabel,
      _credits_remaining: clients[token].credits
    });

  } catch(err) {
    console.error('Create-page error:', err);
    res.status(500).json({ error: 'Seitenerstellung fehlgeschlagen', details: err.message });
  }
});

// ── AUTO-BLOG: Neuen Blogbeitrag generieren und per FTP hochladen ────────────

const FTP_HOST = 'tojopo.han-solo.net';
const FTP_USER = process.env.FTP_USER || 'admin';
const FTP_PASS = process.env.FTP_PASS || '';
const FTP_SITE = 'ftp://tojopo.han-solo.net/noexec/ailima.de';
const NETRC_FILE = '/tmp/ailima-netrc';

const BLOG_HERO_PHOTOS = [
  'photo-1557804506-669a67965ba0', 'photo-1460925895917-afdab827c52f',
  'photo-1547658719-da2b51169166', 'photo-1573167507387-6b4b98cb7c13',
  'photo-1600880292203-757bb62b4baf', 'photo-1542744173-8e7e53415bb0',
  'photo-1551650975-87deedd944c3', 'photo-1553729459-efe14ef6055d',
  'photo-1423666639041-f56000c27a9a'
];

function run(cmd, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function setupFtpNetrc() {
  fs.writeFileSync(NETRC_FILE, `machine ${FTP_HOST}\nlogin ${FTP_USER}\npassword ${FTP_PASS}\n`, { mode: 0o600 });
}

async function ftpGet(remotePath, localPath) {
  await run(`curl --netrc-file "${NETRC_FILE}" -s -o "${localPath}" "${FTP_SITE}/${remotePath}"`, 30000);
}

async function ftpPut(localPath, remotePath) {
  await run(`curl --netrc-file "${NETRC_FILE}" -s -T "${localPath}" "${FTP_SITE}/${remotePath}"`, 30000);
}

function todayDE() {
  const m = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const d = new Date();
  return `${d.getDate()}. ${m[d.getMonth()]} ${d.getFullYear()}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function generateAndUploadBlogPost() {
  console.log('[auto-blog] Starte Blog-Generierung…');
  setupFtpNetrc();

  // Dateien herunterladen
  await ftpGet('blog/index.html', '/tmp/ab-index.html');
  await ftpGet('blog/oeffnungszeiten-website-falsch.html', '/tmp/ab-vorlage.html');
  await ftpGet('sitemap.xml', '/tmp/ab-sitemap.xml');

  const indexHtml  = fs.readFileSync('/tmp/ab-index.html',  'utf8');
  const vorlage    = fs.readFileSync('/tmp/ab-vorlage.html', 'utf8');

  // Vorhandene Slugs extrahieren
  const existingSlugs = [...indexHtml.matchAll(/href="([a-z0-9][a-z0-9-]+\.html)"/gi)]
    .map(m => m[1].replace('.html', ''))
    .filter(s => !['index','impressum','datenschutz'].includes(s));
  const slugList = [...new Set(existingSlugs)].join(', ');

  const dateDE  = todayDE();
  const dateISO = todayISO();

  // Claude generiert den neuen Post
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 8000,
      system: `Du erstellst Blog-Posts für ailima.de. Antworte NUR in diesem Format – zuerst 5 Kommentarzeilen, dann direkt das komplette HTML ohne Markdown-Fence:

<!--SLUG:dein-slug-->
<!--TITLE:Vollständiger Titel-->
<!--CATEGORY:Kategorie-->
<!--EXCERPT:1-2 Sätze Teaser.-->
<!--HEROPIC:photo-XXXXXXXXXX-->
<!DOCTYPE html>
...`,
      messages: [{
        role: 'user',
        content: `Erstelle einen neuen deutschen Blog-Post für ailima.de.

Bereits vorhandene Slugs (nicht nochmal verwenden): ${slugList}

Wähle ein NEUES Thema für kleine lokale Unternehmen (Friseur, Handwerker, Restaurant, Einzelhandel) rund um Website-Pflege, Online-Marketing, lokale Sichtbarkeit oder Digitalisierung.

Datum: ${dateDE} | ISO: ${dateISO}
Hero-Foto-IDs (eine wählen): ${BLOG_HERO_PHOTOS.join(', ')}

700-900 Wörter, 3-4 h2-Abschnitte, eine inline-CTA-Box mit Ailima als Lösung. Ton: freundlich, lösungsorientiert.

Verwende EXAKT diese Vorlage (Nav, Footer, CSS identisch übernehmen):

${vorlage.slice(0, 20000)}`.slice(0, 60000)
      }]
    })
  });

  const cData = await claudeRes.json();
  if (!claudeRes.ok) throw new Error(cData.error?.message || 'Claude API Fehler');

  const raw = (cData.content?.[0]?.text || '').trim()
    .replace(/^```html\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  // Metadaten aus Kommentaren parsen
  const slug     = (raw.match(/<!--SLUG:([a-z0-9-]{3,40})-->/)     || [])[1] || 'neuer-post';
  const title    = (raw.match(/<!--TITLE:([^\n>]+)-->/)             || [])[1]?.trim() || slug;
  const category = (raw.match(/<!--CATEGORY:([^\n>]+)-->/)          || [])[1]?.trim() || 'Marketing';
  const excerpt  = (raw.match(/<!--EXCERPT:([^\n>]+)-->/)           || [])[1]?.trim() || '';
  const heroPic  = (raw.match(/<!--HEROPIC:(photo-[a-z0-9-]+)-->/)  || [])[1] || BLOG_HERO_PHOTOS[0];

  const postHtml = raw.replace(/<!--[^\n>]+-->\n?/g, '').trim();
  if (!postHtml.includes('<!DOCTYPE') && !postHtml.includes('<html'))
    throw new Error('Kein gültiges HTML erhalten');

  const safeSlug = slug.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

  // Post-Datei schreiben
  fs.writeFileSync(`/tmp/ab-${safeSlug}.html`, postHtml, 'utf8');

  // Blog-Index: neue Card vorne einfügen
  const newCard = `
      <a href="${safeSlug}.html" class="blog-card">
        <img class="blog-card-img" src="https://images.unsplash.com/${heroPic}?w=600&q=80&fit=crop" alt="${title}" loading="lazy" />
        <div class="blog-card-body">
          <div class="blog-card-meta">
            <span class="blog-card-cat">${category}</span>
            <span class="blog-card-date">${dateDE}</span>
          </div>
          <h2>${title}</h2>
          <p>${excerpt}</p>
          <span class="blog-card-link">Lesen &#8594; </span>
        </div>
      </a>`;

  const gridMark = 'class="blog-grid">';
  const gPos = indexHtml.indexOf(gridMark);
  const newIndex = gPos !== -1
    ? indexHtml.slice(0, gPos + gridMark.length) + newCard + indexHtml.slice(gPos + gridMark.length)
    : indexHtml;
  fs.writeFileSync('/tmp/ab-index.html', newIndex, 'utf8');

  // Sitemap aktualisieren
  let sitemap = fs.readFileSync('/tmp/ab-sitemap.xml', 'utf8');
  const sitemapEntry = `  <url>\n    <loc>https://www.ailima.de/blog/${safeSlug}.html</loc>\n    <lastmod>${dateISO}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
  sitemap = sitemap.includes('</urlset>')
    ? sitemap.replace('</urlset>', sitemapEntry + '</urlset>')
    : sitemap + sitemapEntry;
  fs.writeFileSync('/tmp/ab-sitemap.xml', sitemap, 'utf8');

  // Upload
  await ftpPut(`/tmp/ab-${safeSlug}.html`, `blog/${safeSlug}.html`);
  await ftpPut('/tmp/ab-index.html', 'blog/index.html');
  await ftpPut('/tmp/ab-sitemap.xml', 'sitemap.xml');

  console.log(`[auto-blog] ✅ Fertig: ${safeSlug} – "${title}"`);
  return { slug: safeSlug, title, category };
}

// GET + POST /api/auto-blog – von GitHub Actions oder externem Cron aufgerufen
app.get('/api/auto-blog',  handleAutoBlog);
app.post('/api/auto-blog', handleAutoBlog);

function handleAutoBlog(req, res) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  res.json({ ok: true, message: 'Blog-Generierung gestartet – Ergebnis im Server-Log.' });
  generateAndUploadBlogPost().catch(err => console.error('[auto-blog] Fehler:', err.message));
}

// ── AUTO-BLOG FAIRWAYAPP ─────────────────────────────────────────────────────

const FTP_SITE_FAIRWAY = 'ftp://tojopo.han-solo.net/noexec/fairwayapp.de';

async function ftpGetFW(remotePath, localPath) {
  await run(`curl --netrc-file "${NETRC_FILE}" -s -o "${localPath}" "${FTP_SITE_FAIRWAY}/${remotePath}"`, 30000);
}
async function ftpPutFW(localPath, remotePath) {
  await run(`curl --netrc-file "${NETRC_FILE}" -s -T "${localPath}" "${FTP_SITE_FAIRWAY}/${remotePath}"`, 30000);
}

const FW_SVG_PATTERNS = [
  `<g fill="none" stroke="#4a9a5c" stroke-width="2" opacity="0.6"><circle cx="300" cy="105" r="45"/><circle cx="300" cy="105" r="85"/><circle cx="300" cy="105" r="130"/></g><line x1="300" y1="105" x2="300" y2="66" stroke="#c9a84c" stroke-width="2.5"/><path d="M300 66 l16 5 -16 5 z" fill="#c9a84c"/><circle cx="300" cy="105" r="4" fill="#ffffff"/>`,
  `<g fill="none" stroke="#4a9a5c" stroke-width="2" opacity="0.6"><ellipse cx="300" cy="100" rx="60" ry="42"/><ellipse cx="300" cy="100" rx="110" ry="76"/><ellipse cx="300" cy="100" rx="165" ry="115"/><ellipse cx="300" cy="100" rx="225" ry="158"/></g><circle cx="300" cy="100" r="5" fill="#c9a84c"/>`,
  `<g stroke="#4a9a5c" stroke-width="1.2" opacity="0.5"><line x1="40" y1="200" x2="110" y2="10"/><line x1="150" y1="200" x2="185" y2="10"/><line x1="260" y1="200" x2="260" y2="10"/><line x1="370" y1="200" x2="335" y2="10"/><line x1="0" y1="150" x2="400" y2="150"/><line x1="30" y1="105" x2="370" y2="105"/><line x1="70" y1="70" x2="330" y2="70"/></g>`,
  `<g fill="none" stroke="#4a9a5c" stroke-width="1.5" opacity="0.55"><path d="M0 160 Q100 80 200 120 T400 100"/><path d="M0 130 Q100 50 200 90 T400 70"/><path d="M0 190 Q100 110 200 150 T400 130"/></g><circle cx="200" cy="110" r="6" fill="#c9a84c"/>`,
];

async function generateAndUploadFairwayBlogPost() {
  console.log('[fw-blog] Starte FairwayApp Blog-Generierung…');
  setupFtpNetrc();

  // Dateien herunterladen
  await ftpGetFW('blog/index.html', '/tmp/fw-index.html');
  await ftpGetFW('blog/golf-app-einfuehren.html', '/tmp/fw-vorlage.html');
  await ftpGetFW('sitemap.xml', '/tmp/fw-sitemap.xml');

  const indexHtml = fs.readFileSync('/tmp/fw-index.html', 'utf8');
  const vorlage   = fs.readFileSync('/tmp/fw-vorlage.html', 'utf8');

  // Vorhandene Slugs extrahieren
  const existingSlugs = [...indexHtml.matchAll(/href="([a-z0-9][a-z0-9-]+\.html)"/gi)]
    .map(m => m[1].replace('.html', ''))
    .filter(s => !['index','impressum','datenschutz','privacy','legal'].includes(s));
  const slugList = [...new Set(existingSlugs)].join(', ');

  const dateDE  = todayDE();
  const dateISO = todayISO();

  // SVG-Pattern rotieren (nach Anzahl bestehender Posts)
  const patternIdx = existingSlugs.length % FW_SVG_PATTERNS.length;
  const svgPattern = FW_SVG_PATTERNS[patternIdx];

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 8000,
      system: `Du erstellst Blog-Posts für fairwayapp.de – eine App für Golfclub-Management. Antworte NUR in diesem Format – zuerst 4 Kommentarzeilen, dann direkt das komplette HTML ohne Markdown-Fence:

<!--SLUG:dein-slug-->
<!--TITLE:Vollständiger Titel-->
<!--CATEGORY:Kategorie-->
<!--EXCERPT:1-2 Sätze Teaser.-->
<!DOCTYPE html>
...`,
      messages: [{
        role: 'user',
        content: `Erstelle einen neuen deutschen Blog-Post für fairwayapp.de.

Bereits vorhandene Slugs (nicht nochmal verwenden): ${slugList}

Wähle ein NEUES Thema rund um Golfclub-Management, Digitalisierung im Golfclub, Mitgliederverwaltung, Turnierorganisation oder Club-App-Einführung. Zielgruppe: Golfclub-Manager und Vorstände.

Kategorie-Optionen: Digitalisierung, Vereinsführung, Spielbetrieb, Events, Marketing, Finanzen

Datum: ${dateDE} | ISO: ${dateISO}

700-900 Wörter, 3-4 h2-Abschnitte, eine inline-CTA-Box mit FairwayApp als Lösung. Ton: professionell, praxisnah.

Verwende EXAKT diese Vorlage (Nav, Footer, CSS identisch übernehmen):

${vorlage.slice(0, 20000)}`.slice(0, 60000)
      }]
    })
  });

  const cData = await claudeRes.json();
  if (!claudeRes.ok) throw new Error(cData.error?.message || 'Claude API Fehler');

  const raw = (cData.content?.[0]?.text || '').trim()
    .replace(/^```html\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  const slug     = (raw.match(/<!--SLUG:([a-z0-9-]{3,40})-->/)  || [])[1] || 'neuer-post';
  const title    = (raw.match(/<!--TITLE:([^\n>]+)-->/)           || [])[1]?.trim() || slug;
  const category = (raw.match(/<!--CATEGORY:([^\n>]+)-->/)        || [])[1]?.trim() || 'Digitalisierung';
  const excerpt  = (raw.match(/<!--EXCERPT:([^\n>]+)-->/)         || [])[1]?.trim() || '';

  const postHtml = raw.replace(/<!--[^\n>]+-->\n?/g, '').trim();
  if (!postHtml.includes('<!DOCTYPE') && !postHtml.includes('<html'))
    throw new Error('Kein gültiges HTML erhalten');

  // Slug sicher machen (Umlaute normalisieren)
  const safeSlug = slug
    .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

  fs.writeFileSync(`/tmp/fw-${safeSlug}.html`, postHtml, 'utf8');

  // Blog-Index: neue Card vorne einfügen
  const newCard = `
      <a href="${safeSlug}.html" class="article-card">
        <div class="card-img"><svg class="card-pattern" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">${svgPattern}</svg>
          <span class="card-tag">${category}</span>
        </div>
        <div class="card-body">
          <div class="card-meta">${dateDE} · 6 Min.</div>
          <h2>${title}</h2>
          <p>${excerpt}</p>
          <span class="card-link">Artikel lesen <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></span>
        </div>
      </a>`;

  const gridMark = 'class="articles-grid">';
  const gPos = indexHtml.indexOf(gridMark);
  const newIndex = gPos !== -1
    ? indexHtml.slice(0, gPos + gridMark.length) + newCard + indexHtml.slice(gPos + gridMark.length)
    : indexHtml;
  fs.writeFileSync('/tmp/fw-index.html', newIndex, 'utf8');

  // Sitemap aktualisieren
  let sitemap = fs.readFileSync('/tmp/fw-sitemap.xml', 'utf8');
  const sitemapEntry = `  <url>\n    <loc>https://www.fairwayapp.de/blog/${safeSlug}.html</loc>\n    <lastmod>${dateISO}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
  sitemap = sitemap.includes('</urlset>')
    ? sitemap.replace('</urlset>', sitemapEntry + '</urlset>')
    : sitemap + sitemapEntry;
  fs.writeFileSync('/tmp/fw-sitemap.xml', sitemap, 'utf8');

  // Upload
  await ftpPutFW(`/tmp/fw-${safeSlug}.html`, `blog/${safeSlug}.html`);
  await ftpPutFW('/tmp/fw-index.html', 'blog/index.html');
  await ftpPutFW('/tmp/fw-sitemap.xml', 'sitemap.xml');

  console.log(`[fw-blog] ✅ Fertig: ${safeSlug} – "${title}"`);
}

app.get('/api/auto-blog-fairway',  handleAutoBlogFairway);
app.post('/api/auto-blog-fairway', handleAutoBlogFairway);

function handleAutoBlogFairway(req, res) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  res.json({ ok: true, message: 'FairwayApp Blog-Generierung gestartet – Ergebnis im Server-Log.' });
  generateAndUploadFairwayBlogPost().catch(err => console.error('[fw-blog] Fehler:', err.message));
}

// ---------- start ----------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SiteAI Proxy running on port ${PORT}`);
  crmReady = restoreCRMFromFtp();
  if (!ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY not set!');
  if (!ADMIN_KEY) console.warn('WARNING: ADMIN_KEY not set!');
});
