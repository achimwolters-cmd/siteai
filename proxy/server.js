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
  if (!ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY not set!');
  if (!ADMIN_KEY) console.warn('WARNING: ADMIN_KEY not set!');
});
