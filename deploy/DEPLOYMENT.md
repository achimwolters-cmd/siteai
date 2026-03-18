# SiteAI Deployment – Schritt-für-Schritt

## Was du brauchst
- Linux-Server (Debian/Ubuntu) mit root/sudo-Zugang
- Deinen `ANTHROPIC_API_KEY` von console.anthropic.com

---

## Schritt 1 – Per SSH auf den Server verbinden

Öffne das **Terminal** (Mac: Spotlight → „Terminal"):

```bash
ssh root@DEINE-SERVER-IP
```

Passwort eingeben wenn gefragt. Du bist jetzt auf dem Server.

---

## Schritt 2 – Setup Script ausführen

```bash
# Script herunterladen und ausführen
curl -fsSL https://raw.githubusercontent.com/achimwolters-cmd/siteai/main/deploy/setup.sh | bash
```

Das Script macht automatisch:
- ✅ Node.js installieren (falls nötig)
- ✅ PM2 installieren (falls nötig)
- ✅ Nginx installieren (falls nötig)
- ✅ Repo nach `/opt/siteai` klonen
- ✅ `npm install`
- ✅ `.env` Datei anlegen
- ✅ Server mit PM2 starten
- ✅ PM2 Autostart einrichten
- ✅ Nginx als Reverse Proxy konfigurieren

---

## Schritt 3 – API-Keys eintragen

Das Script pausiert und zeigt dir diesen Hinweis:

```
WICHTIG: Trage jetzt deine API-Keys ein:
  nano /opt/siteai/proxy/.env
```

Öffne die Datei:
```bash
nano /opt/siteai/proxy/.env
```

Trage ein:
```
ANTHROPIC_API_KEY=sk-ant-api03-...   ← von console.anthropic.com
ADMIN_KEY=mein-sicheres-passwort     ← frei wählbar, merken!
PORT=3000
```

Speichern: `Ctrl+O` → Enter → `Ctrl+X`

---

## Schritt 4 – Script nochmal ausführen

```bash
curl -fsSL https://raw.githubusercontent.com/achimwolters-cmd/siteai/main/deploy/setup.sh | bash
```

Jetzt läuft der Server durch bis zum Ende.

---

## Schritt 5 – Testen

```bash
# Läuft der Server?
curl http://DEINE-SERVER-IP/health

# Erwartete Antwort:
# {"status":"ok","timestamp":"..."}
```

---

## Ersten Kunden anlegen

```bash
cd /opt/siteai/proxy
node admin.js add "Mustermann GmbH" 30
```

Ausgabe:
```
✅ Kunde angelegt: Mustermann GmbH
   Token  : sat_abc123...
   Credits: 30
```

Diesen Token in den Editor eintragen:
```javascript
const CLIENT_TOKEN = 'sat_abc123...';
const PROXY_URL    = 'http://DEINE-SERVER-IP';
```

---

## Nützliche Befehle auf dem Server

```bash
pm2 status                    # Läuft der Server?
pm2 logs siteai-proxy         # Live-Logs anschauen
pm2 restart siteai-proxy      # Server neu starten
pm2 stop siteai-proxy         # Server stoppen

# Update auf neueste Version
curl -fsSL https://raw.githubusercontent.com/achimwolters-cmd/siteai/main/deploy/update.sh | bash
```

---

## SSL mit eigener Domain (später)

Wenn du später eine Domain hast (z.B. `api.haarwerk-schmidt.de`):

```bash
# 1. Domain-A-Record auf Server-IP setzen (bei deinem Domain-Anbieter)
# 2. Certbot einrichten
apt install certbot python3-certbot-nginx -y
certbot --nginx -d api.deine-domain.de

# 3. Fertig – automatisches HTTPS!
```

---

## Firewall (empfohlen)

```bash
ufw allow 22     # SSH – wichtig, sonst sperrst du dich aus!
ufw allow 80     # HTTP
ufw allow 443    # HTTPS (für später)
ufw enable
```
