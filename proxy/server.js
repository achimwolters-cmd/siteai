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
  res.json({ status: 'ok', commit: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7), timestamp: new Date().toISOString() });
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
const { findEmail, siteSnapshot, domainAcceptsMail } = require('./lib/site-tools');
const SMTP_HOST      = process.env.SMTP_HOST || 'tojopo.han-solo.net';
const SMTP_PORT      = parseInt(process.env.SMTP_PORT) || 587;
const SMTP_USER      = process.env.SMTP_USER || 'achim@ailima.de';
const SMTP_PASS      = process.env.SMTP_PASS || '';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'Achim Wolters';

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const DEMO_URL = 'https://siteai-khmo.onrender.com/demo/?edit=sat_4ug6sat368k4ew976lr8z';

// Personal mail with a small business-card signature and a soft demo link – no buttons or banners.
// Guarantees a readable structure even if the AI returns one block: greeting on its own line, short paragraphs.
function toParagraphs(body) {
  let t = body.trim().replace(/\r/g, '');
  t = t.replace(/^((?:guten tag|hallo|liebe[rs]?|sehr geehrte[rs]?)[^,\n]{0,60},)[ \t]*\n?(?!\n)/i, '$1\n\n');
  const parts = t.split(/\n{2,}/);
  if (parts.length >= 3) return t;
  const [greeting, ...rest] = parts.length === 2 ? parts : ['', t];
  const sentences = rest.join(' ').replace(/\s*\n\s*/g, ' ').match(/[^.!?]+[.!?]+["“”»«)]*\s*|[^.!?]+$/g) || [];
  if (sentences.length < 3) return t;
  const last = sentences.pop().trim();
  const mid = Math.ceil(sentences.length / 2);
  return [greeting, sentences.slice(0, mid).join('').trim(), sentences.slice(mid).join('').trim(), last].filter(Boolean).join('\n\n');
}

function buildMail(body) {
  // The AI sometimes adds its own closing despite instructions; the template adds one.
  body = toParagraphs(body.trim()
    .replace(/\n+\s*(viele|beste|freundliche|herzliche|liebe|schöne)\s+grüße[\s\S]{0,80}$/i, '')
    .replace(/\n+\s*(gruß|grüße|achim|achim wolters)[\s,.]*$/i, ''));
  const plain = body.trim().replace(/\*\*(.+?)\*\*/g, '$1');
  const text = `${plain}\n\nWer vorher schon schauen möchte: Live-Demo in 2 Minuten ausprobieren – ${DEMO_URL}\n\nViele Grüße\n${SMTP_FROM_NAME}\nGründer · Ailima\nwww.ailima.de · ${SMTP_USER}\n\n--\nKein Interesse? Eine kurze Antwort genügt, dann melde ich mich nicht wieder.\nImpressum: https://www.ailima.de/impressum.html`;
  const paragraphs = plain.split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 16px">${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const link = 'color:#3d8a96;text-decoration:none';
  const html = `<!doctype html><html><body style="margin:0;padding:0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:28px 28px 32px">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#1f2d33;max-width:560px">
${paragraphs}
<p style="margin:0 0 22px;padding:12px 14px;background:#f2f8f9;border-radius:8px;font-size:14px;color:#3d5a60">&#128073; Wer vorher schon schauen möchte: <a href="${DEMO_URL}" style="color:#2a6670;font-weight:600">Live-Demo in 2 Minuten ausprobieren</a></p>
<p style="margin:0 0 18px">Viele Grüße</p>
<table cellpadding="0" cellspacing="0" border="0"><tr>
  <td width="36" style="width:36px;padding-right:14px;vertical-align:middle"><img src="cid:ailima-logo" width="36" height="49" alt="Ailima" style="display:block;width:36px;height:49px;max-width:36px;border:0"></td>
  <td style="border-left:3px solid #3d8a96;padding:2px 0 2px 14px;font-size:13px;line-height:1.55;color:#5b6b70;vertical-align:middle">
    <div style="font-size:15px;font-weight:600;color:#1f2d33">${escHtml(SMTP_FROM_NAME)}</div>
    <div>Gründer · <span style="font-weight:700;color:#1f2d33">Ai</span><span style="font-weight:700;color:#3d8a96">lima</span></div>
    <div><a href="https://www.ailima.de" style="${link}">www.ailima.de</a> · <a href="mailto:${SMTP_USER}" style="${link}">${SMTP_USER}</a></div>
  </td></tr></table>
<p style="margin:22px 0 0;font-size:11px;color:#a3adb1">Kein Interesse? Eine kurze Antwort genügt, dann melde ich mich nicht wieder. · <a href="https://www.ailima.de/impressum.html" style="color:#a3adb1">Impressum</a></p>
</div></td></tr></table></body></html>`;
  return {
    text,
    html,
    // Tiny dedicated file: clients that ignore width/height can't blow it up.
    attachments: [{ filename: 'ailima.png', path: path.join(__dirname, 'public', 'mail-logo.png'), cid: 'ailima-logo' }],
  };
}

// Send the current draft right away to any address (e.g. a spam tester). Touches no lead, not counted in the daily limit.
const testSends = [];
app.post('/crm/test-send', requireCRM, async (req, res) => {
  const to = String(req.body.to || '').trim();
  const { subject, body } = req.body;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Ungültige Empfänger-Adresse' });
  if (!subject || !body) return res.status(400).json({ error: 'Betreff und Text erforderlich' });
  const dayAgo = Date.now() - 86400000;
  while (testSends.length && testSends[0] < dayAgo) testSends.shift();
  if (testSends.length >= 10) return res.status(429).json({ error: 'Maximal 10 Testmails pro Tag' });
  try {
    await sendWithFallback({ from: `"${SMTP_FROM_NAME}" <${SMTP_USER}>`, to, subject, ...buildMail(body) });
    testSends.push(Date.now());
    console.log(`[Test] Testmail an ${to}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/crm/preview-email', requireCRM, (req, res) => {
  const { html } = buildMail(String(req.body.body || ''));
  res.json({ html: html.replace('cid:ailima-logo', '/mail-logo.png') });
});

function smtpTransport(port = SMTP_PORT) {
  return nodemailer.createTransport({
    host: SMTP_HOST, port, secure: port === 465,
    name: domainOf(SMTP_USER) || 'ailima.de',
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false },
  });
}

// Port 587 occasionally times out from Render's shared egress IPs; 465 is the fallback.
async function sendWithFallback(message) {
  try {
    return await smtpTransport().sendMail(message);
  } catch (e) {
    const network = /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(`${e.code} ${e.message}`);
    if (!network || SMTP_PORT === 465) throw e;
    console.warn(`[SMTP] Port ${SMTP_PORT} nicht erreichbar (${e.message}) – versuche 465`);
    return await smtpTransport(465).sendMail(message);
  }
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
const SUBJECT_FALLBACK = lead => `Kurze Frage zu ${hostOf(lead.website) || lead.company}`;

// Writes a short, personal first mail. Reads the lead's website first so the AI can refer to something real.
async function generateInitialMail(lead, settings, extraHint = '') {
  const snapshot = lead.website ? await siteSnapshot(lead.website) : null;
  const industryHint = (settings?.industryHints?.[lead.industry] || '').trim();
  const hints = [industryHint, String(extraHint || '').trim().slice(0, 1000)].filter(Boolean);
  const year = new Date().getFullYear();
  const siteInfo = snapshot
    ? `Website (${snapshot.url}) – Titel: ${snapshot.title || '–'}${snapshot.copyrightYear ? `, Copyright-Jahr im Footer: ${snapshot.copyrightYear}` : ''}\nText-Auszug:\n${snapshot.text}`
    : 'Website: nicht abrufbar oder unbekannt';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system: `Du schreibst als ${SMTP_FROM_NAME}, Gründer von Ailima, eine kurze, persönliche Erst-Mail an einen lokalen Betrieb. Es soll sich lesen wie von einem Menschen getippt, nicht wie Werbung.

Ailima: ein Assistent direkt auf der eigenen Website. Man schreibt auf Deutsch, was sich ändern soll (Öffnungszeiten, Preise, Texte, Fotos), und es ist sofort online – ohne Agentur oder Programmierer.

REGELN:
- 60–90 Wörter, Sie-Form, schlicht und freundlich. Kein Marketing-Sprech, keine Superlative, keine Ausrufezeichen, keine Komplimente oder Wertungen (nicht „beeindruckend", „toll").
- Behaupte nur, was wörtlich im Website-Auszug steht – keine Annahmen über Alter, Pflege oder Zustand der Website.
- Anrede: Ansprechpartner falls bekannt („Guten Tag Frau/Herr …"), sonst „Guten Tag,". Die Anrede steht allein in der ersten Zeile.
- Aufbau: nach der Anrede 3 kurze Absätze (Vorstellung + Beobachtung / Nutzen / Frage), jeweils durch eine LEERZEILE getrennt.
- Erster Satz: stell dich in einem Halbsatz vor (Name, Ailima) UND nenne EINE konkrete, wahre Beobachtung von der Website (z. B. was sie anbieten, eine Aktion, Öffnungszeiten, ein veraltetes Jahr). Erfinde nichts – steht nichts Brauchbares im Auszug, beziehe dich nur allgemein auf ihr Angebot. Ist das Copyright-Jahr älter als ${year - 1}, darfst du es freundlich erwähnen.
- Dann in 1–2 Sätzen, was Ailima konkret für diesen Betrieb erleichtert.
- Kein Preis, keine Links/URLs, kein Fettdruck, keine Aufzählungen.
- Ende mit EINER lockeren Frage mit niedriger Hürde, z. B. „Soll ich Ihnen kurz zeigen, wie das auf Ihrer Seite aussehen würde?"
- Keine Grußformel, keine Signatur.${hints.length ? `
- Zusätzlich kurz berücksichtigen (Bedingungen darin beachten):
${hints.map(h => '  • ' + h).join('\n')}` : ''}

Antworte NUR mit JSON: {"subject":"…","body":"…"}
Betreff: kurz, klein, persönlich, ohne Werbewörter – z. B. „Kurze Frage zu ${hostOf(lead.website) || 'Ihrer Website'}" oder „${lead.company} – Ihre Website".`,
      messages: [{ role: 'user', content:
        `Firma: ${lead.company}\nBranche: ${lead.industry || 'lokales Unternehmen'}\nOrt: ${lead.city || ''}\nAnsprechpartner: ${lead.contact || 'unbekannt'}\n${siteInfo}` }],
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'KI-Fehler');
  const raw = d.content?.[0]?.text || '';
  let parsed = {};
  try { parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch {}
  const body = String(parsed.body || '').trim();
  if (!body) throw new Error('KI hat keinen Text geliefert');
  const subject = String(parsed.subject || '').trim().slice(0, 90) || SUBJECT_FALLBACK(lead);
  return { subject, body, personalized: !!snapshot };
}

app.post('/crm/generate-email/:id', requireCRM, async (req, res) => {
  try {
    const data = loadCRM();
    const lead = data.leads.find(l => l.id === req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (lead.emailSentAt) return res.status(400).json({ error: 'Die erste Mail wurde bereits gesendet – hier gibt es nur noch Follow-ups' });
    const { subject, body } = await generateInitialMail(lead, data.settings, req.body?.extraHint);
    const draft = { subject, body, generatedAt: new Date().toISOString() };
    const fresh = await patchLeads([[lead.id, l => l.emailSentAt || l.queuedMail ? l : ({ ...l, emailDraft: draft, mailStatus: 'draft',
      updatedAt: new Date().toISOString(), updatedBy: req.crmUser, updatedByName: req.crmName })]]);
    res.json({ draft, lead: fresh.leads.find(l => l.id === lead.id) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Rewrite a queued first mail with the current prompt, keeping its place in the queue
app.post('/crm/queue/regenerate/:id', requireCRM, async (req, res) => {
  try {
    const data = loadCRM();
    const lead = data.leads.find(l => l.id === req.params.id);
    if (!lead?.queuedMail || lead.queuedMail.kind !== 'initial') return res.status(400).json({ error: 'Keine wartende Erstmail' });
    const { subject, body } = await generateInitialMail(lead, data.settings);
    const fresh = await patchLeads([[lead.id, l => l.queuedMail?.kind !== 'initial' ? l : ({ ...l,
      queuedMail: { ...l.queuedMail, subject, body, rewrittenAt: new Date().toISOString() },
      emailDraft: { subject, body, generatedAt: new Date().toISOString() } })]]);
    res.json({ lead: fresh.leads.find(l => l.id === lead.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send approved email via SMTP
// ── CRM: Versand-Warteschlange (schützt die Absender-Reputation) ──
// Mails gehen nur werktags im Versandfenster raus, mit zufälligem Abstand und Tageslimit.
// Warm-up for the new sender address: [from date (Berlin), mails per day]. SEND_DAILY_LIMIT overrides.
const SEND_WARMUP = [['2026-10-26', 60], ['2026-10-23', 40], ['0000-00-00', 25]];
function dailyLimit(ymd, leads) {
  if (process.env.SEND_DAILY_LIMIT) return parseInt(process.env.SEND_DAILY_LIMIT);
  const planned = SEND_WARMUP.find(([from]) => ymd >= from)[1];
  // Brake: too many bounces hurt sender reputation, so stay at the start level.
  const weekAgo = Date.now() - 7 * 86400000;
  const recent = leads.filter(l => l.emailSentAt && new Date(l.emailSentAt) > weekAgo);
  const bounced = recent.filter(l => l.emailBounced).length;
  if (recent.length >= 20 && bounced / recent.length > 0.05) return SEND_WARMUP[SEND_WARMUP.length - 1][1];
  return planned;
}
const SEND_GAP_MIN_MS  = (parseInt(process.env.SEND_GAP_MIN) || 4) * 60000;
const SEND_GAP_MAX_MS  = (parseInt(process.env.SEND_GAP_MAX) || 9) * 60000;
const SEND_HOUR_FROM = 8, SEND_HOUR_TO = 18;
let nextGapMs = SEND_GAP_MIN_MS;
let lastAttemptAt = 0;
let queueBusy = false;

function berlinParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { weekday: p.weekday, hour: parseInt(p.hour) % 24, ymd: `${p.year}-${p.month}-${p.day}` };
}
const inSendWindow = d => { const p = berlinParts(d); return !['Sat', 'Sun'].includes(p.weekday) && p.hour >= SEND_HOUR_FROM && p.hour < SEND_HOUR_TO; };
const pickGap = () => SEND_GAP_MIN_MS + Math.random() * (SEND_GAP_MAX_MS - SEND_GAP_MIN_MS);

function sentTimestamps(leads) {
  return leads.flatMap(l => [l.emailSentAt, l.followUp1SentAt, l.followUp2SentAt]).filter(Boolean).map(t => new Date(t));
}

function queueState(leads, now = new Date()) {
  const sent = sentTimestamps(leads);
  const today = berlinParts(now).ymd;
  const sentToday = sent.filter(t => berlinParts(t).ymd === today).length;
  const lastSent = sent.length ? new Date(Math.max(...sent)) : null;
  return { sentToday, lastSent };
}

const queuedLeads = leads => leads.filter(l => l.queuedMail && !l.archived)
  .sort((x, y) => x.queuedMail.queuedAt.localeCompare(y.queuedMail.queuedAt));

// Rough schedule for the UI: walks forward in time respecting window, gap and daily limit.
function estimateSchedule(leads) {
  const { sentToday, lastSent } = queueState(leads);
  const avgGap = (SEND_GAP_MIN_MS + SEND_GAP_MAX_MS) / 2;
  let t = new Date(Math.max(Date.now(), lastSent ? lastSent.getTime() + nextGapMs : 0));
  let day = berlinParts(t).ymd, count = berlinParts(new Date()).ymd === day ? sentToday : 0;
  const etas = {};
  for (const l of queuedLeads(leads)) {
    for (let guard = 0; guard < 5000; guard++) {
      const d = berlinParts(t).ymd;
      if (d !== day) { day = d; count = 0; }
      if (inSendWindow(t) && count < dailyLimit(day, leads)) break;
      t = new Date(t.getTime() + 15 * 60000);
    }
    etas[l.id] = t.toISOString();
    count++;
    t = new Date(t.getTime() + avgGap);
  }
  return etas;
}

// Background jobs await network calls; they must patch the *current* CRM state, not a stale snapshot.
async function patchLeads(patches, mutateData) {
  const data = loadCRM();
  for (const [id, apply] of patches) {
    const idx = data.leads.findIndex(l => l.id === id);
    if (idx !== -1) data.leads[idx] = apply(data.leads[idx]);
  }
  if (mutateData) mutateData(data);
  await saveCRM(data);
  return data;
}

// Statuses where the conversation is handled personally – no automatic follow-ups.
const NO_FOLLOWUP_STATUS = new Set(['in_kontakt', 'termin', 'gewonnen', 'kein_interesse']);
const followUpBlocked = l => NO_FOLLOWUP_STATUS.has(l.status) || !!l.replyAt || !!l.emailBounced || l.archived;

async function deliver(lead, subject, body, kind) {
  const thread = kind !== 'initial' && lead.emailMessageId
    ? { inReplyTo: lead.emailMessageId, references: [lead.emailMessageId, ...(lead.followUpMessageIds || [])].join(' ') }
    : {};
  const info = await sendWithFallback({
    from: `"${SMTP_FROM_NAME}" <${SMTP_USER}>`,
    to: lead.email,
    subject,
    ...thread,
    ...buildMail(body),
  });
  return info.messageId;
}

function applySent(lead, kind, subject, now, messageId) {
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  if (kind === 'initial') return { ...lead, status: 'angeschrieben', mailStatus: 'sent', emailSentAt: now, emailSubject: subject, emailMessageId: messageId, followUp: in7, channel: 'email', emailDraft: null };
  const followUpMessageIds = [...(lead.followUpMessageIds || []), messageId].filter(Boolean);
  if (kind === 'fu1') return { ...lead, mailStatus: 'fu1_sent', followUp1SentAt: now, followUp: in7, followUpMessageIds };
  return { ...lead, mailStatus: 'fu2_sent', followUp2SentAt: now, followUp: '', followUpMessageIds };
}

async function processQueue() {
  if (queueBusy || !SMTP_PASS) return;
  queueBusy = true;
  try {
    await crmReady;
    const now = new Date();
    if (!inSendWindow(now)) return;
    const data = loadCRM();
    const next = queuedLeads(data.leads)[0];
    if (!next) return;
    const { sentToday, lastSent } = queueState(data.leads, now);
    if (sentToday >= dailyLimit(berlinParts(now).ymd, data.leads)) return;
    if (lastSent && now - lastSent < nextGapMs) return;
    if (now - lastAttemptAt < nextGapMs) return;
    lastAttemptAt = now.getTime();

    let { kind, subject, body } = next.queuedMail;
    const stamp = now.toISOString();
    // Last safety net: rewrite a faulty text before it goes out; if that fails, hold it back for review.
    const issues = mailIssues(body);
    if (issues.length) {
      try {
        ({ subject, body } = kind === 'initial'
          ? await generateInitialMail(next, data.settings)
          : await generateFollowUp(next, { ignorePrepared: true }));
        if (mailIssues(body).length) throw new Error(mailIssues(body).join(', '));
        await patchLeads([[next.id, l => l.queuedMail ? { ...l, queuedMail: { ...l.queuedMail, subject, body, rewrittenAt: stamp } } : l]]);
        console.log(`[Queue] ${next.company}: Text neu geschrieben (${issues.join(', ')})`);
      } catch (e) {
        lastAttemptAt = 0;
        await patchLeads([[next.id, l => { if (!l.queuedMail) return l; const { queuedMail, ...rest } = l; return { ...rest, updatedAt: stamp,
          ...(kind === 'initial' ? { mailStatus: 'draft', emailDraft: { subject, body, generatedAt: stamp } } : { fuDraft: { kind, subject, body, createdAt: stamp } }),
          notes: `${l.notes ? l.notes + '\n' : ''}⚠️ Mail zurückgehalten (${issues.join(', ')}) – bitte prüfen` }; }]]);
        console.log(`[Queue] ${next.company}: zurückgehalten (${issues.join(', ')})`);
        return;
      }
    }
    if (kind !== 'initial' && followUpBlocked(next)) {
      await patchLeads([[next.id, l => { const { queuedMail, ...rest } = l; return { ...rest, updatedAt: stamp }; }]]);
      console.log(`[Queue] Follow-up an ${next.company} verworfen – Lead hat geantwortet bzw. Status ${next.status}`);
      return;
    }
    if (!(await domainAcceptsMail(next.email))) {
      // Never send to a domain that can't receive mail: a sure bounce hurts sender reputation.
      lastAttemptAt = 0;
      await patchLeads([[next.id, l => { const { queuedMail, ...rest } = l; return { ...rest,
        emailBounced: true, invalidDomain: true, mailStatus: 'bounced', followUp: '', updatedAt: stamp,
        bouncedEmails: [...new Set([...(l.bouncedEmails || []), l.email].filter(Boolean))],
        ...(kind === 'initial' ? { emailDraft: { subject, body, generatedAt: stamp } } : {}),
        notes: `${l.notes ? l.notes + '\n' : ''}⚠️ Domain von ${l.email} nimmt keine Mails an – nicht gesendet` }; }]]);
      console.log(`[Queue] ${next.company}: Domain nimmt keine Mails an – übersprungen`);
      findAlternative(next.id).catch(() => {});
      return;
    }
    let patch;
    try {
      const messageId = await deliver(next, subject, body, kind);
      // Keep the exact text that went out, so it can be checked and shown later.
      patch = l => { const { queuedMail, sendError, ...rest } = applySent(l, kind, subject, stamp, messageId);
        return { ...rest, updatedAt: stamp, sentMails: [...(l.sentMails || []), { kind, subject, body, sentAt: stamp }] }; };
      console.log(`[Queue] gesendet (${kind}) an ${next.company}`);
    } catch (e) {
      const attempts = (next.queuedMail.attempts || 0) + 1;
      console.error(`[Queue] Fehler bei ${next.company} (Versuch ${attempts}):`, e.message);
      patch = l => {
        if (!l.queuedMail) return l;
        // Move to the back so one failing address doesn't block the rest of the queue.
        if (attempts < 3) return { ...l, queuedMail: { ...l.queuedMail, attempts, lastError: e.message, queuedAt: new Date().toISOString() } };
        const { queuedMail, ...rest } = l;
        return { ...rest, sendError: e.message, updatedAt: stamp,
          ...(kind === 'initial' ? { mailStatus: 'draft', emailDraft: { subject, body, generatedAt: stamp } } : {}) };
      };
    }
    nextGapMs = pickGap();
    await patchLeads([[next.id, patch]]);
  } catch (e) {
    console.error('[Queue]', e.message);
  } finally {
    queueBusy = false;
  }
}
setInterval(processQueue, 30000);

// Render free tier sleeps after 15 min without traffic; keep awake while mails are waiting.
setInterval(() => {
  if (!process.env.RENDER_EXTERNAL_URL) return;
  if (!queuedLeads(loadCRM().leads).length) return;
  fetch(`${process.env.RENDER_EXTERNAL_URL}/health`).catch(() => {});
}, 10 * 60000);

function enqueue(lead, kind, subject, body, user) {
  const now = new Date().toISOString();
  return { ...lead,
    queuedMail: { kind, subject, body, queuedAt: now, queuedBy: user },
    ...(kind === 'initial' ? { mailStatus: 'queued', emailDraft: { subject, body, generatedAt: lead.emailDraft?.generatedAt || now } } : { fuPrepared: undefined }),
    sendError: undefined, updatedAt: now, updatedBy: user };
}

function queueResponse(leads) {
  const etas = estimateSchedule(leads);
  const { sentToday } = queueState(leads);
  return { sentToday, limit: dailyLimit(berlinParts(new Date()).ymd, leads), windowOpen: inSendWindow(new Date()),
    window: `Mo–Fr ${SEND_HOUR_FROM}–${SEND_HOUR_TO} Uhr`,
    queue: queuedLeads(leads).map(l => ({ id: l.id, company: l.company, email: l.email, kind: l.queuedMail.kind,
      subject: l.queuedMail.subject, eta: etas[l.id], lastError: l.queuedMail.lastError || '', rewritten: !!l.queuedMail.rewrittenAt })) };
}

app.get('/crm/queue', requireCRM, (req, res) => res.json(queueResponse(loadCRM().leads)));

// Put a (edited) mail into the queue instead of sending immediately
app.post('/crm/send-email/:id', requireCRM, async (req, res) => {
  if (!SMTP_PASS) return res.status(500).json({ error: 'SMTP_PASS nicht in Render konfiguriert' });
  try {
    const data = loadCRM();
    const idx = data.leads.findIndex(l => l.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Lead nicht gefunden' });
    const lead = data.leads[idx];
    if (!lead.email) return res.status(400).json({ error: 'Keine E-Mail-Adresse eingetragen' });
    if (lead.emailSentAt) return res.status(400).json({ error: 'Erste Mail wurde bereits gesendet' });
    const { subject, body } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'Betreff und Text erforderlich' });

    data.leads[idx] = enqueue(lead, 'initial', subject, body, req.crmUser);
    await saveCRM(data);
    const q = queueResponse(data.leads);
    res.json({ ok: true, lead: data.leads[idx], eta: q.queue.find(x => x.id === lead.id)?.eta });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Queue all existing drafts of the given leads
app.post('/crm/queue/add-drafts', requireCRM, async (req, res) => {
  try {
    const ids = new Set(req.body.ids || []);
    const data = loadCRM();
    let added = 0;
    data.leads = data.leads.map(l => {
      if (!ids.has(l.id) || l.mailStatus !== 'draft' || !l.email || !l.emailDraft?.subject || l.queuedMail) return l;
      added++;
      return enqueue(l, 'initial', l.emailDraft.subject, l.emailDraft.body, req.crmUser);
    });
    await saveCRM(data);
    res.json({ added, leads: data.leads.filter(l => ids.has(l.id)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/crm/queue/cancel/:id', requireCRM, async (req, res) => {
  try {
    const data = loadCRM();
    const idx = data.leads.findIndex(l => l.id === req.params.id);
    if (idx === -1 || !data.leads[idx].queuedMail) return res.status(404).json({ error: 'Nicht in der Warteschlange' });
    const { queuedMail, ...rest } = data.leads[idx];
    data.leads[idx] = { ...rest, updatedAt: new Date().toISOString(), updatedBy: req.crmUser,
      ...(queuedMail.kind === 'initial' ? { mailStatus: 'draft', emailDraft: { subject: queuedMail.subject, body: queuedMail.body, generatedAt: queuedMail.queuedAt } } : {}) };
    await saveCRM(data);
    res.json({ ok: true, lead: data.leads[idx] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Text problems that must never reach a prospect: informal address ("du/ihr") or made-up timing ("gestern").
const DU_FORM = /\b(du|dich|dir|dein\w*|euch|euer|eure\w*|ihr|habt|seid|Du|Dich|Dir|Dein\w*|Euch|Euer|Eure\w*|Habt|Seid)\b/;
const TIME_REF = /\b(gestern|gestrig\w*|vorgestern|heute früh|letzte[nrs]? Woche|vor (einer|einigen|ein paar|zwei|drei|\d+) (Tag|Tagen|Woche|Wochen))\b/i;
// Misspelt product name (e.g. "Aiuma", "Alima"): any Ai…/Al…ma word that isn't exactly "Ailima".
const BAD_NAME = /\b(?!Ailima\b)(Ai[a-zäöü]{0,4}ma|Alia?ma|Aliima)\b/i;
function mailIssues(body) {
  const issues = [];
  if (BAD_NAME.test(body)) issues.push('Produktname falsch geschrieben');
  if (DU_FORM.test(body)) issues.push('duzt statt siezt');
  if (TIME_REF.test(body)) issues.push('nennt einen Zeitpunkt');
  return issues;
}

async function generateFollowUp(lead, opts = {}) {
  let last;
  for (let i = 0; i < 3; i++) {
    last = await generateFollowUpOnce(lead, i ? { ...opts, ignorePrepared: true } : opts);
    if (!mailIssues(last.body).length) return last;
  }
  throw new Error(`Follow-up für ${lead.company} fehlerhaft (${mailIssues(last.body).join(', ')})`);
}

async function generateFollowUpOnce(lead, { ignorePrepared = false } = {}) {
  const isFU2 = !!lead.followUp1SentAt;
  if (!ignorePrepared && lead.fuPrepared?.kind === (isFU2 ? 'fu2' : 'fu1')) {
    return { isFU2, subject: lead.fuPrepared.subject, body: lead.fuPrepared.body };
  }
  const salutation = lead.contact ? `Sprich ${lead.contact} persönlich an („Guten Tag Frau/Herr …").` : 'Anrede genau: „Guten Tag," (kein Name, kein „Liebe …Team").';

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 350,
      system: `Du schreibst als ${SMTP_FROM_NAME} (Ailima: Website per Nachricht selbst ändern, ohne Agentur) eine ${isFU2 ? 'letzte, abschließende' : 'kurze Nachfass-'}Mail im selben Mail-Verlauf.
Persönlich, schlicht, wie von Hand getippt. ${isFU2 ? '30–50' : '40–70'} Wörter. Kein Preis, kein Marketing-Sprech, kein Fettdruck, keine Ausrufezeichen. Ende mit einer lockeren Frage. ${salutation}
Der Produktname lautet exakt „Ailima" – nie anders schreiben.
Immer siezen (Sie, Ihnen, Ihre) – niemals du, ihr, euch, eure, habt.
Nenne keinen Zeitpunkt der vorigen Mail (kein „gestern", „letzte Woche", „vor X Tagen") – schreib höchstens „meine letzte Mail".
Erfinde nichts: beschreibe nicht, was in der vorigen Mail stand, und nichts über deine Gedanken oder Gefühle.
Schlussfrage schlicht und natürlich, z. B. „Wäre das grundsätzlich interessant für Sie?" oder „Soll ich Ihnen kurz zeigen, wie das aussieht?".
NUR E-Mail-Text ab der Anrede, keine Betreffzeile, keine Grußformel am Ende, keine Signatur, keine URL.`,
      messages: [{ role: 'user', content: isFU2
        ? `Letzte höfliche Abschlussnachricht an ${lead.company} (${lead.industry||''}). Haben auf 2 Mails nicht geantwortet. Tür offen lassen für die Zukunft. Kein Verkaufsdruck.`
        : `Follow-up an ${lead.company} (${lead.industry||''}). Keine Antwort auf die erste Mail. Neuen Gedanken einbringen: Website ist oft das erste was Kunden sehen – veraltete Infos kosten Vertrauen.` }],
    }),
  });
  const cData = await claudeRes.json();
  const body = (cData.content?.[0]?.text || '').trim();
  if (!body) throw new Error('KI hat keinen Text geliefert');
  const origSubject = lead.emailSubject || `Ihre Website – selbst aktualisieren, ganz ohne Programmierer`;
  const subject = `Re: ${origSubject.replace(/^(re:\s*)+/i, '')}`;

  return { isFU2, subject, body };
}

// Preview the next follow-up without scheduling anything
app.post('/crm/followup-preview/:id', requireCRM, async (req, res) => {
  try {
    const lead = loadCRM().leads.find(l => l.id === req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (!lead.emailSentAt || lead.followUp2SentAt) return res.status(400).json({ error: 'Für diesen Lead ist kein Follow-up mehr vorgesehen' });
    if (followUpBlocked(lead)) return res.status(400).json({ error: 'Lead hat geantwortet bzw. ist in Kontakt – kein Follow-up nötig' });
    const { isFU2, subject, body } = await generateFollowUp(lead, { ignorePrepared: !!req.body.regenerate });
    res.json({ kind: isFU2 ? 'fu2' : 'fu1', subject, body, prepared: !req.body.regenerate && !!lead.fuPrepared, dueDate: lead.followUp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Keep a reviewed follow-up text for the due date
app.post('/crm/followup-prepare/:id', requireCRM, async (req, res) => {
  const { subject, body, kind } = req.body;
  if (!subject || !body || !['fu1', 'fu2'].includes(kind)) return res.status(400).json({ error: 'Betreff und Text erforderlich' });
  const data = await patchLeads([[req.params.id, l => ({ ...l, fuPrepared: { kind, subject, body, at: new Date().toISOString() }, updatedAt: new Date().toISOString(), updatedBy: req.crmUser })]]);
  res.json({ lead: data.leads.find(l => l.id === req.params.id) });
});

// Generate a follow-up and put it into the queue
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
    if (lead.queuedMail) return res.status(400).json({ error: 'Für diesen Lead wartet schon eine Mail in der Warteschlange' });
    if (followUpBlocked(lead)) return res.status(400).json({ error: 'Lead hat geantwortet bzw. ist in Kontakt – kein Follow-up nötig' });

    const { isFU2, subject, body } = await generateFollowUp(lead);
    const fresh = await patchLeads([[lead.id, l => l.queuedMail || followUpBlocked(l) ? l : enqueue(l, isFU2 ? 'fu2' : 'fu1', subject, body, req.crmUser)]]);
    const q = queueResponse(fresh.leads);
    res.json({ ok: true, fuType: isFU2 ? 2 : 1, lead: fresh.leads.find(l => l.id === lead.id), eta: q.queue.find(x => x.id === lead.id)?.eta });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CRM: Posteingang – Antworten & Rückläufer automatisch erkennen ──
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const IMAP_HOST = process.env.IMAP_HOST || SMTP_HOST;
const IMAP_PORT = parseInt(process.env.IMAP_PORT) || 993;
const FREEMAIL = new Set(['gmx.de','gmx.net','web.de','gmail.com','googlemail.com','t-online.de','outlook.com','outlook.de',
  'hotmail.com','hotmail.de','yahoo.com','yahoo.de','icloud.com','me.com','freenet.de','posteo.de','aol.com','live.de','mail.de','arcor.de']);
const inbox = { lastCheck: null, lastError: '', processed: 0, running: false };

const domainOf = e => (e || '').toLowerCase().split('@')[1] || '';
const normId = id => (id || '').trim().replace(/^<|>$/g, '').toLowerCase();

// Matched mails are moved out of the inbox into these folders (created on first use).
const INBOX_FOLDERS = { reply: ['Ailima', 'Antworten'], auto: ['Ailima', 'Automatisch'], bounce: ['Ailima', 'Unzustellbar'] };
const INBOX_MOVE = process.env.INBOX_MOVE !== 'off';

async function ensureInboxFolders(client) {
  const ns = client.namespace || { prefix: '', delimiter: '/' };
  const delim = ns.delimiter || '/';
  const existing = new Set((await client.list()).map(b => b.path));
  const paths = {};
  for (const [key, parts] of Object.entries(INBOX_FOLDERS)) {
    const parent = ns.prefix + parts[0];
    const full = ns.prefix + parts.join(delim);
    for (const p of [parent, full]) {
      if (existing.has(p)) continue;
      await client.mailboxCreate(p);
      try { await client.mailboxSubscribe(p); } catch {}
      existing.add(p);
      console.log(`[Inbox] Ordner angelegt: ${p}`);
    }
    paths[key] = full;
  }
  return paths;
}

function isBounce(mail) {
  const from = (mail.from?.value?.[0]?.address || '').toLowerCase();
  const ct = (mail.headers.get('content-type')?.value || '').toLowerCase();
  return /mailer-daemon|postmaster/.test(from) || ct === 'multipart/report' ||
    /undeliverable|unzustellbar|delivery status notification|returned mail|nicht zugestellt|failure notice/i.test(mail.subject || '');
}

function isAutoReply(mail) {
  const auto = String(mail.headers.get('auto-submitted') || '').toLowerCase();
  const precedence = String(mail.headers.get('precedence') || '').toLowerCase();
  return (auto && auto !== 'no') || /auto_reply|bulk|junk/.test(precedence) ||
    mail.headers.has('x-autoreply') || mail.headers.has('x-autorespond') || mail.headers.has('x-auto-response-suppress') ||
    /abwesen|out of office|automatische antwort|auto-?reply|autoreply|urlaub|nicht im büro|vacation|eingangsbestätigung|danke für ihre (nachricht|e-?mail|anfrage)|vielen dank für ihre (nachricht|e-?mail|anfrage)|wir haben ihre (nachricht|e-?mail|anfrage) erhalten|thank you for your (message|email)/i.test(mail.subject || '');
}

function stripQuoted(text) {
  const lines = (text || '').split('\n');
  const cut = lines.findIndex(l => /^>|^-{2,}\s*(original|ursprüngliche)|^am .+ schrieb|^on .+ wrote|^von:\s|^from:\s/i.test(l.trim()));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim().slice(0, 2000);
}

function findLeadForReply(leads, mail) {
  const refs = [mail.inReplyTo, ...(Array.isArray(mail.references) ? mail.references : [mail.references])].filter(Boolean).map(normId);
  if (refs.length) {
    const byThread = leads.find(l => [l.emailMessageId, ...(l.followUpMessageIds || [])].map(normId).some(id => id && refs.includes(id)));
    if (byThread) return byThread;
  }
  const from = (mail.from?.value?.[0]?.address || '').toLowerCase();
  const contacted = leads.filter(l => l.emailSentAt && l.email);
  const byAddress = contacted.find(l => l.email.toLowerCase() === from);
  if (byAddress) return byAddress;
  const dom = domainOf(from);
  if (!dom || FREEMAIL.has(dom)) return null;
  return contacted.find(l => domainOf(l.email) === dom || hostOf(l.website) === dom) || null;
}

function findLeadForBounce(leads, mail) {
  const text = `${mail.text || ''}\n${(mail.attachments || []).map(a => a.content?.toString('utf8') || '').join('\n')}`.toLowerCase();
  const recip = text.match(/(?:final|original)-recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)/i)?.[1];
  const contacted = leads.filter(l => l.emailSentAt && l.email);
  if (recip) { const hit = contacted.find(l => l.email.toLowerCase() === recip.toLowerCase()); if (hit) return hit; }
  return contacted.find(l => text.includes(l.email.toLowerCase())) || null;
}

async function classifyReply(lead, text) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5', max_tokens: 200,
        system: 'Du ordnest Antworten auf Akquise-Mails für Ailima (KI-Website-Editor) ein. Antworte NUR mit JSON: {"category":"interessiert|termin|frage|kein_interesse|auto_reply|sonstiges","summary":"ein kurzer deutscher Satz"}. "termin" nur wenn ein konkreter Termin/Rückruf vereinbart oder angefragt wird. "auto_reply" für automatische Antworten, Eingangsbestätigungen, Abwesenheitsnotizen und Standardtexte ohne persönlichen Bezug auf unsere Mail.',
        messages: [{ role: 'user', content: `Antwort von ${lead.company}:\n\n${text.slice(0, 1500)}` }],
      }),
    });
    const d = await r.json();
    const parsed = JSON.parse((d.content?.[0]?.text || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
    return { category: parsed.category || 'sonstiges', summary: parsed.summary || '' };
  } catch {
    return { category: 'sonstiges', summary: '' };
  }
}

const STATUS_RANK = { neu: 0, angeschrieben: 1, in_kontakt: 2, termin: 3, gewonnen: 4 };
function statusForCategory(current, category) {
  if (category === 'kein_interesse') return current === 'gewonnen' ? current : 'kein_interesse';
  const target = category === 'termin' ? 'termin' : 'in_kontakt';
  return (STATUS_RANK[current] ?? 0) >= STATUS_RANK[target] ? current : target;
}

async function checkInbox() {
  if (inbox.running || !SMTP_PASS) return;
  inbox.running = true;
  const client = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: true, auth: { user: SMTP_USER, pass: SMTP_PASS }, logger: false });
  try {
    await crmReady;
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const data = loadCRM();
      const st = data.inboxState || {};
      const validity = String(client.mailbox.uidValidity);
      const sentTimes = sentTimestamps(data.leads);
      if (st.uidValidity !== validity || !st.lastUid) {
        // First run: only look at mail since the first campaign mail (max. 30 days back).
        const since = new Date(Math.max(Date.now() - 30 * 86400000, sentTimes.length ? Math.min(...sentTimes) : Date.now()));
        const uids = await client.search({ since }, { uid: true });
        st.uidValidity = validity;
        st.lastUid = uids.length ? Math.min(...uids) - 1 : (client.mailbox.uidNext - 1);
      }
      let changed = false;
      const patches = [];
      const moves = { reply: [], auto: [], bounce: [] };
      const bouncedIds = [];
      const messages = [];
      for await (const msg of client.fetch(`${st.lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
        if (msg.uid > st.lastUid) messages.push(msg);
      }
      for (const msg of messages) {
        st.lastUid = Math.max(st.lastUid, msg.uid);
        changed = true;
        const mail = await simpleParser(msg.source);
        const now = new Date().toISOString();
        if (isBounce(mail)) {
          const lead = findLeadForBounce(data.leads, mail);
          if (!lead) continue;
          bouncedIds.push(lead.id);
          patches.push([lead.id, l => { const { queuedMail, ...rest } = l; return { ...rest,
            emailBounced: true, mailStatus: 'bounced', followUp: '', updatedAt: now,
            bouncedEmails: [...new Set([...(l.bouncedEmails || []), l.email].filter(Boolean))],
            notes: `${l.notes ? l.notes + '\n' : ''}⚠️ Mail unzustellbar (${new Date().toLocaleDateString('de-DE')})` }; }]);
          inbox.processed++;
          moves.bounce.push(msg.uid);
          console.log(`[Inbox] Rückläufer: ${lead.company}`);
          continue;
        }
        const lead = findLeadForReply(data.leads, mail);
        if (!lead) continue;
        const text = stripQuoted(mail.text || '');
        if (isAutoReply(mail)) {
          patches.push([lead.id, l => ({ ...l, lastAutoReply: { at: now, subject: mail.subject || '', text: text.slice(0, 500) } })]);
          moves.auto.push(msg.uid);
          continue;
        }
        const { category, summary } = await classifyReply(lead, text);
        if (category === 'auto_reply') {
          patches.push([lead.id, l => ({ ...l, lastAutoReply: { at: now, subject: mail.subject || '', text: text.slice(0, 500), summary } })]);
          console.log(`[Inbox] Auto-Antwort (KI) von ${lead.company}`);
          moves.auto.push(msg.uid);
          continue;
        }
        const reply = { at: (mail.date || new Date()).toISOString(), from: mail.from?.text || '', subject: mail.subject || '', text, category, summary };
        patches.push([lead.id, l => {
          const { queuedMail, fuDraft, ...rest } = l;
          return { ...rest, ...(queuedMail?.kind === 'initial' ? { queuedMail } : {}),
            replies: [...(l.replies || []), reply], replyAt: now, newReply: true, mailStatus: 'replied', followUp: '',
            status: statusForCategory(l.status, category), updatedAt: now };
        }]);
        inbox.processed++;
        moves.reply.push(msg.uid);
        console.log(`[Inbox] Antwort von ${lead.company} → ${category}`);
      }
      if (changed) await patchLeads(patches, d => { d.inboxState = st; });
      bouncedIds.forEach(id => findAlternative(id).catch(e => console.error('[Bounce]', e.message)));
      if (INBOX_MOVE && Object.values(moves).some(u => u.length)) {
        try {
          const paths = await ensureInboxFolders(client);
          for (const [key, uids] of Object.entries(moves)) {
            if (uids.length) await client.messageMove(uids.join(','), paths[key], { uid: true });
          }
        } catch (e) {
          console.error('[Inbox] Verschieben fehlgeschlagen:', e.message);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    inbox.lastError = '';
  } catch (e) {
    inbox.lastError = e.message;
    console.error('[Inbox]', e.message);
    try { client.close(); } catch {}
  } finally {
    inbox.lastCheck = new Date().toISOString();
    inbox.running = false;
  }
}
setInterval(checkInbox, 3 * 60000);
setTimeout(checkInbox, 20000);

// Undo a reply that was really an automatic answer: restore the follow-up sequence.
app.post('/crm/leads/:id/not-a-reply', requireCRM, async (req, res) => {
  const data = await patchLeads([[req.params.id, l => {
    if (!l.replies?.length) return l;
    const last = l.replies[l.replies.length - 1];
    const lastSent = l.followUp2SentAt || l.followUp1SentAt || l.emailSentAt;
    const followUp = l.followUp2SentAt ? '' : new Date(new Date(lastSent).getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const { replies, replyAt, newReply, ...rest } = l;
    return { ...rest, status: 'angeschrieben', followUp,
      mailStatus: l.followUp2SentAt ? 'fu2_sent' : l.followUp1SentAt ? 'fu1_sent' : 'sent',
      lastAutoReply: { at: last.at, subject: last.subject, text: (last.text || '').slice(0, 500), summary: last.summary },
      updatedAt: new Date().toISOString(), updatedBy: req.crmUser };
  }]]);
  res.json({ lead: data.leads.find(l => l.id === req.params.id) });
});

// After a bounce: look for another address on the lead's website, or flag the site as dead.
async function findAlternative(leadId) {
  const lead = loadCRM().leads.find(l => l.id === leadId);
  if (!lead) return null;
  const tried = [...new Set([...(lead.bouncedEmails || []), lead.email].filter(Boolean))];
  let result = { altEmail: '', websiteDead: false };
  if (lead.website) {
    try {
      const found = await findEmail(lead.website, tried);
      if (found && await domainAcceptsMail(found)) result.altEmail = found;
    } catch {
      result.websiteDead = true;
    }
  }
  const data = await patchLeads([[leadId, l => ({ ...l, ...result, altSearchedAt: new Date().toISOString() })]]);
  console.log(`[Bounce] ${lead.company}: ${result.altEmail ? 'neue Adresse ' + result.altEmail : result.websiteDead ? 'Website tot' : 'keine andere Adresse'}`);
  return data.leads.find(l => l.id === leadId);
}

app.post('/crm/leads/:id/find-email', requireCRM, async (req, res) => {
  try { res.json({ lead: await findAlternative(req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Switch a bounced lead to the newly found address and start over with a fresh first mail
app.post('/crm/leads/:id/use-alt-email', requireCRM, async (req, res) => {
  const data = await patchLeads([[req.params.id, l => {
    if (!l.altEmail) return l;
    const { altEmail, emailBounced, invalidDomain, websiteDead, emailSentAt, emailMessageId, emailSubject, followUpMessageIds, emailDraft, queuedMail, ...rest } = l;
    return { ...rest, email: altEmail, status: 'neu', mailStatus: undefined, followUp: '',
      notes: `${l.notes ? l.notes + '\n' : ''}📧 Neue Adresse ${altEmail} (vorher ${l.email})`,
      updatedAt: new Date().toISOString(), updatedBy: req.crmUser };
  }]]);
  res.json({ lead: data.leads.find(l => l.id === req.params.id) });
});

app.get('/crm/inbox-status', requireCRM, (req, res) => res.json({ enabled: !!SMTP_PASS, ...inbox, autoFollowUp: loadCRM().settings?.autoFollowUp || 'draft' }));
app.post('/crm/inbox-check', requireCRM, async (req, res) => { await checkInbox(); res.json({ ...inbox, leads: loadCRM().leads }); });

// ── CRM: Automatische Follow-ups ──
// Modus 'off' | 'draft' (zur Freigabe im Ausgang) | 'auto' (direkt in die Warteschlange)
let autoFuBusy = false;
async function runAutoFollowUps() {
  if (autoFuBusy || !SMTP_PASS || !ANTHROPIC_API_KEY) return;
  autoFuBusy = true;
  try {
    await crmReady;
    const data = loadCRM();
    const mode = data.settings?.autoFollowUp || 'draft';
    if (mode === 'off') return;
    const today = new Date().toISOString().slice(0, 10);
    const due = data.leads.filter(l => !followUpBlocked(l) && !l.queuedMail && !l.fuDraft && l.email &&
      (l.mailStatus === 'sent' || l.mailStatus === 'fu1_sent') && !l.followUp2SentAt && l.followUp && l.followUp <= today).slice(0, 10);
    if (!due.length) return;
    const patches = [];
    for (const lead of due) {
      try {
        const { isFU2, subject, body } = await generateFollowUp(lead);
        const kind = isFU2 ? 'fu2' : 'fu1';
        patches.push([lead.id, l => {
          if (followUpBlocked(l) || l.queuedMail || l.fuDraft) return l;
          return mode === 'auto'
            ? enqueue(l, kind, subject, body, 'auto')
            : { ...l, fuDraft: { kind, subject, body, createdAt: new Date().toISOString() } };
        }]);
        console.log(`[Auto-FU] ${kind} für ${lead.company} → ${mode === 'auto' ? 'Warteschlange' : 'Entwurf'}`);
      } catch (e) {
        console.error(`[Auto-FU] ${lead.company}:`, e.message);
      }
    }
    if (patches.length) await patchLeads(patches);
  } finally {
    autoFuBusy = false;
  }
}
setInterval(runAutoFollowUps, 15 * 60000);
setTimeout(runAutoFollowUps, 60000);

app.get('/crm/settings', requireCRM, (req, res) => res.json({ settings: loadCRM().settings || {} }));

app.post('/crm/settings', requireCRM, async (req, res) => {
  const data = loadCRM();
  const settings = { ...(data.settings || {}) };
  const { autoFollowUp, industry, industryHint } = req.body;
  if (autoFollowUp !== undefined) {
    if (!['off', 'draft', 'auto'].includes(autoFollowUp)) return res.status(400).json({ error: 'Ungültiger Modus' });
    settings.autoFollowUp = autoFollowUp;
  }
  if (industry) {
    const hints = { ...(settings.industryHints || {}) };
    const text = String(industryHint || '').trim().slice(0, 1000);
    if (text) hints[industry] = text; else delete hints[industry];
    settings.industryHints = hints;
  }
  data.settings = settings;
  await saveCRM(data);
  res.json({ settings });
  if (autoFollowUp && autoFollowUp !== 'off') runAutoFollowUps();
});

// Release (optionally edited) follow-up draft into the queue, or discard it
app.post('/crm/fu-draft/:id', requireCRM, async (req, res) => {
  const data = loadCRM();
  const idx = data.leads.findIndex(l => l.id === req.params.id);
  if (idx === -1 || !data.leads[idx].fuDraft) return res.status(404).json({ error: 'Kein Follow-up-Entwurf vorhanden' });
  const { fuDraft, ...lead } = data.leads[idx];
  if (req.body.action === 'discard') {
    data.leads[idx] = { ...lead, followUp: '', updatedAt: new Date().toISOString(), updatedBy: req.crmUser };
  } else {
    if (followUpBlocked(lead)) return res.status(400).json({ error: 'Lead hat inzwischen geantwortet – kein Follow-up nötig' });
    data.leads[idx] = enqueue(lead, fuDraft.kind, req.body.subject || fuDraft.subject, req.body.body || fuDraft.body, req.crmUser);
  }
  await saveCRM(data);
  const q = queueResponse(data.leads);
  res.json({ lead: data.leads[idx], eta: q.queue.find(x => x.id === req.params.id)?.eta });
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
      if (p.email && !p.websiteDead && !inCRM(p, idx)) i.available++;
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
      (!onlyEmail || p.email) && !p.websiteDead &&
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
