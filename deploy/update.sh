#!/bin/bash
# ════════════════════════════════════════════════════════════
#  SiteAI – Update Script
#  Neueste Version vom GitHub ziehen und neu starten
# ════════════════════════════════════════════════════════════
set -e
APP_DIR="/opt/siteai"

echo "[SiteAI] Update wird gestartet…"
cd "$APP_DIR"
git pull
cd proxy
npm install --silent --production
pm2 restart siteai-proxy
echo "[SiteAI] ✅ Update fertig!"
pm2 status siteai-proxy
