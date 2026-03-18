#!/bin/bash
# ════════════════════════════════════════════════════════════
#  SiteAI – Server Setup Script
#  Läuft auf einem frischen Debian/Ubuntu Server
#  Voraussetzung: root oder sudo-Nutzer
# ════════════════════════════════════════════════════════════
set -e

# ── Farben ──
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[SiteAI]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ════════════════════════════════════════════════════════════
# 0. Konfiguration – HIER ANPASSEN
# ════════════════════════════════════════════════════════════
APP_DIR="/opt/siteai"
PROXY_PORT=3000
NGINX_PORT=80

# ════════════════════════════════════════════════════════════
# 1. System-Updates
# ════════════════════════════════════════════════════════════
log "System wird aktualisiert…"
apt-get update -qq && apt-get upgrade -y -qq

# ════════════════════════════════════════════════════════════
# 2. Node.js installieren (falls nicht vorhanden)
# ════════════════════════════════════════════════════════════
if ! command -v node &>/dev/null; then
  log "Node.js wird installiert…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
log "Node.js Version: $(node -v)"

# ════════════════════════════════════════════════════════════
# 3. PM2 installieren (falls nicht vorhanden)
# ════════════════════════════════════════════════════════════
if ! command -v pm2 &>/dev/null; then
  log "PM2 wird installiert…"
  npm install -g pm2 --silent
fi
log "PM2 Version: $(pm2 -v)"

# ════════════════════════════════════════════════════════════
# 4. Nginx installieren (falls nicht vorhanden)
# ════════════════════════════════════════════════════════════
if ! command -v nginx &>/dev/null; then
  log "Nginx wird installiert…"
  apt-get install -y nginx
fi

# ════════════════════════════════════════════════════════════
# 5. App-Verzeichnis anlegen und Repo klonen
# ════════════════════════════════════════════════════════════
log "Repository wird geklont nach $APP_DIR…"
if [ -d "$APP_DIR" ]; then
  warn "$APP_DIR existiert bereits – wird aktualisiert (git pull)"
  cd "$APP_DIR" && git pull
else
  git clone https://github.com/achimwolters-cmd/siteai.git "$APP_DIR"
fi

# ════════════════════════════════════════════════════════════
# 6. Dependencies installieren
# ════════════════════════════════════════════════════════════
log "npm install…"
cd "$APP_DIR/proxy"
npm install --silent --production

# ════════════════════════════════════════════════════════════
# 7. .env erstellen (falls nicht vorhanden)
# ════════════════════════════════════════════════════════════
if [ ! -f "$APP_DIR/proxy/.env" ]; then
  log ".env wird erstellt – bitte die Werte eintragen!"
  cp "$APP_DIR/proxy/.env.example" "$APP_DIR/proxy/.env"
  warn "WICHTIG: Trage jetzt deine API-Keys ein:"
  warn "  nano $APP_DIR/proxy/.env"
  warn ""
  warn "  ANTHROPIC_API_KEY=sk-ant-..."
  warn "  ADMIN_KEY=sicheres-passwort"
  warn "  PORT=3000"
  warn ""
  warn "Danach dieses Script erneut ausführen ODER manuell starten:"
  warn "  cd $APP_DIR/proxy && pm2 start server.js --name siteai-proxy"
  exit 0
fi

# ════════════════════════════════════════════════════════════
# 8. PM2 starten
# ════════════════════════════════════════════════════════════
log "SiteAI Proxy wird mit PM2 gestartet…"
cd "$APP_DIR/proxy"

# Stoppe alten Prozess falls vorhanden
pm2 stop siteai-proxy 2>/dev/null || true
pm2 delete siteai-proxy 2>/dev/null || true

# Starte neu
pm2 start server.js --name siteai-proxy

# PM2 beim Systemstart automatisch starten
pm2 startup | tail -1 | bash || true
pm2 save

log "PM2 Status:"
pm2 status siteai-proxy

# ════════════════════════════════════════════════════════════
# 9. Nginx konfigurieren
# ════════════════════════════════════════════════════════════
log "Nginx wird konfiguriert…"

# Hole Server-IP automatisch
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

cat > /etc/nginx/sites-available/siteai <<NGINX
# SiteAI Proxy – Nginx Config
# Generiert von setup.sh am $(date)

server {
    listen $NGINX_PORT;
    server_name $SERVER_IP _;

    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";

    # Proxy zu Node.js
    location / {
        proxy_pass         http://127.0.0.1:$PROXY_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_cache_bypass \$http_upgrade;

        # Timeout für lange KI-Anfragen
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
        proxy_send_timeout 120s;

        # CORS wird vom Node-Server gesetzt – nicht doppeln
    }
}
NGINX

# Aktivieren
ln -sf /etc/nginx/sites-available/siteai /etc/nginx/sites-enabled/siteai
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

# Testen und neu laden
nginx -t && systemctl reload nginx

# ════════════════════════════════════════════════════════════
# 10. Health Check
# ════════════════════════════════════════════════════════════
log "Warte 3 Sekunden…"
sleep 3

log "Health Check…"
HEALTH=$(curl -s http://localhost:$PROXY_PORT/health 2>/dev/null)
if echo "$HEALTH" | grep -q '"ok"'; then
  log "✅ Server läuft! Health: $HEALTH"
else
  warn "Health Check fehlgeschlagen. Prüfe: pm2 logs siteai-proxy"
fi

# ════════════════════════════════════════════════════════════
# Fertig
# ════════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════"
echo "  SiteAI Proxy erfolgreich deployed!"
echo "════════════════════════════════════════"
echo "  URL:     http://$SERVER_IP"
echo "  Health:  http://$SERVER_IP/health"
echo "  Logs:    pm2 logs siteai-proxy"
echo "  Status:  pm2 status"
echo ""
echo "  Ersten Kunden anlegen:"
echo "  cd $APP_DIR/proxy && node admin.js add \"Kundenname GmbH\" 30"
echo "════════════════════════════════════════"
