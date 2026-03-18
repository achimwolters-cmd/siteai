# SiteAI

KI-gestützter Website-Editor für kleine lokale Unternehmen.

## Struktur

```
siteai/
├── proxy/      ← Node.js Proxy Server (Claude API + Credit-System)
├── editor/     ← Editor-Frontend (eine HTML-Datei pro Kunde)
└── sites/      ← Nachgebaute Kunden-Websites
```

## Proxy Server

```bash
cd proxy
cp .env.example .env   # echte Keys eintragen
npm install
node server.js
```

### Kunden verwalten (CLI)

```bash
node admin.js list
node admin.js add "Mustermann GmbH" 30
node admin.js credits <token> 50
node admin.js disable <token>
```

## Endpoints

| Method | Pfad | Beschreibung |
|--------|------|--------------|
| GET | /health | Health Check |
| GET | /api/status | Guthaben-Stand (x-client-token) |
| POST | /api/chat | KI-Anfrage proxy (x-client-token) |
| GET | /admin/clients | Alle Kunden (x-admin-key) |
| POST | /admin/clients | Neuen Kunden anlegen (x-admin-key) |
| POST | /admin/clients/:token/credits | Credits aufladen (x-admin-key) |
| POST | /admin/clients/:token/enable | Aktivieren (x-admin-key) |
| POST | /admin/clients/:token/disable | Deaktivieren (x-admin-key) |
| DELETE | /admin/clients/:token | Löschen (x-admin-key) |
