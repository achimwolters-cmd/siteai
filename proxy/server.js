// Ailima Proxy Server – last deploy trigger: 2026-06-08
require('dotenv').config({ override: true });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

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
  next();
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

// Export CRM seed (for Railway CRM_SEED env var)
app.get('/crm/backup', requireCRM, (req, res) => {
  const data = loadCRM();
  const seed = JSON.stringify({ leads: data.leads, sessions: {} });
  res.json({ seed });
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

  const { pageContext, pageName, navLabel, description, site } = req.body;
  const siteName  = (site || '').replace(/[^a-z0-9-]/g, '');
  const safeSlug  = (pageName || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);

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
Seitenname: ${navLabel || safeSlug}
URL: /${safeSlug}/
Inhalt/Zweck: ${description || navLabel || safeSlug}

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

// ---------- start ----------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SiteAI Proxy running on port ${PORT}`);
  if (!ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY not set!');
  if (!ADMIN_KEY) console.warn('WARNING: ADMIN_KEY not set!');
});
