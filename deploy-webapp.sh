#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# deploy-webapp.sh — Build Expo web locally, tar+scp to qc-sgp, serve via nginx
#
# Usage:
#   ./deploy-webapp.sh               # Full build + deploy
#   ./deploy-webapp.sh --skip-build  # Deploy existing dist only
#
# Replaces the Docker-based webapp deploy with direct static file serving.
# Eliminates the double-nginx layer (host nginx → Docker nginx → files).
#
# Flow:
#   1. Build happy-wire + Expo export
#   2. Pack dist/ into tar.gz, scp to remote, extract in-place
#   3. Update nginx config (first run only)
#   4. Reload nginx

# ── Config ─────────────────────────────────────────────────────────────────
REMOTE_HOST="qc-sgp"
REMOTE_WEB_ROOT="/var/www/happy-web"
REMOTE_NGINX_CONF="/etc/nginx/sites-enabled/happy-web.sg.c1tas.pw"
LOCAL_DIST="packages/happy-app/dist"
LOCAL_TAR="/tmp/happy-web.tar.gz"
TAR_FILE="happy-web.tar.gz"

# Jump host relay (same as deploy-server.sh)
JUMP_HOST="root@192.168.58.120"
JUMP_SHARE_DIR="/root/share"
JUMP_HTTP_URL="http://183.222.16.203:57878"

# ── Colors ─────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }
info() { echo -e "  ${CYAN}→${NC} $*"; }
warn() { echo -e "  ${YELLOW}!${NC} $*"; }
step() { echo -e "\n${BOLD}[$1] $2${NC}"; }

SKIP_BUILD=false
if [[ "${1:-}" == "--skip-build" ]]; then
    SKIP_BUILD=true
fi

echo -e "${BOLD}Deploying webapp to ${CYAN}${REMOTE_HOST}${NC}${BOLD} (static)${NC}"

# ── Step 1: Build ─────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == true ]]; then
    step "1/4" "Skipping build (--skip-build)"
    if [[ ! -d "$LOCAL_DIST" ]]; then
        fail "No dist found at ${LOCAL_DIST}. Run without --skip-build first."
        exit 1
    fi
    ok "Using existing dist"
else
    step "1/4" "Building web app"

    info "Building happy-wire..."
    yarn workspace @slopus/happy-wire build
    ok "happy-wire built"

    info "Exporting Expo web..."
    EXPO_PUBLIC_HAPPY_SERVER_URL=https://happy.sg.c1tas.pw \
    APP_ENV=production NODE_ENV=production \
        yarn workspace happy-app expo export --platform web --output-dir dist
    ok "Expo web exported to ${LOCAL_DIST}"
fi

FILE_COUNT=$(find "$LOCAL_DIST" -type f | wc -l)
DIST_SIZE=$(du -sh "$LOCAL_DIST" | cut -f1)
info "dist: ${FILE_COUNT} files, ${DIST_SIZE}"

# ── Step 2: Pack, upload via jump host, extract ──────────────────────────
step "2/4" "Packing and uploading via jump host"

info "Creating tar.gz..."
tar -czf "${LOCAL_TAR}" -C "${LOCAL_DIST}" .
TAR_SIZE=$(du -h "${LOCAL_TAR}" | cut -f1)
ok "Packed: ${LOCAL_TAR} (${TAR_SIZE})"

info "Uploading to jump host (${JUMP_HOST})..."
scp "${LOCAL_TAR}" "${JUMP_HOST}:${JUMP_SHARE_DIR}/${TAR_FILE}"
ok "Uploaded to jump host"

info "Downloading on ${REMOTE_HOST} via HTTP..."
ssh "${REMOTE_HOST}" "rm -f /tmp/${TAR_FILE} && wget --user bdsec --password ensec123 -nv -o /dev/stderr -O /tmp/${TAR_FILE} ${JUMP_HTTP_URL}/${TAR_FILE}" 2>&1 | while IFS= read -r line; do
    echo -e "  ${DIM}${line}${NC}"
done
ok "Downloaded on remote"

info "Extracting on remote (atomic replace)..."
ssh "${REMOTE_HOST}" "
    rm -rf ${REMOTE_WEB_ROOT}.new &&
    mkdir -p ${REMOTE_WEB_ROOT}.new &&
    tar -xzf /tmp/${TAR_FILE} -C ${REMOTE_WEB_ROOT}.new &&
    rm -rf ${REMOTE_WEB_ROOT}.old &&
    ( [ -d ${REMOTE_WEB_ROOT} ] && mv ${REMOTE_WEB_ROOT} ${REMOTE_WEB_ROOT}.old || true ) &&
    mv ${REMOTE_WEB_ROOT}.new ${REMOTE_WEB_ROOT} &&
    rm -rf ${REMOTE_WEB_ROOT}.old /tmp/${TAR_FILE}
"
ok "Deployed to ${REMOTE_WEB_ROOT}"

rm -f "${LOCAL_TAR}"

# ── Step 3: Update nginx config ──────────────────────────────────────────
step "3/4" "Checking nginx config"

NEEDS_NGINX_UPDATE=$(ssh "${REMOTE_HOST}" "grep -c 'proxy_pass' ${REMOTE_NGINX_CONF}" 2>/dev/null || echo "0")

if [[ "$NEEDS_NGINX_UPDATE" != "0" ]]; then
    info "Switching nginx from Docker proxy to static serving..."

    ssh "${REMOTE_HOST}" "cat > ${REMOTE_NGINX_CONF}" <<'NGINX_EOF'
server {
    listen 443 ssl http2;
    server_name happy-web.sg.c1tas.pw;

    underscores_in_headers on;
    ssl_certificate /nginxweb/cert/sg.pem;
    ssl_certificate_key /nginxweb/cert/sg.key;
    ssl_session_timeout 5m;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:HIGH:!aNULL:!MD5:!RC4:!DHE;
    ssl_prefer_server_ciphers on;

    access_log /var/log/nginx/happyweb.access.log;
    error_log /var/log/nginx/happyweb.error.log;

    root /var/www/happy-web;

    # ── Performance: gzip ──────────────────────────────────────────────
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_min_length 256;
    gzip_types
        text/plain
        text/css
        text/javascript
        application/javascript
        application/json
        application/wasm
        application/xml
        image/svg+xml;

    # Serve pre-compressed .gz files if available (e.g. from build step)
    gzip_static on;

    # ── Performance: sendfile + buffering ──────────────────────────────
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;

    # ── Static assets with long cache ──────────────────────────────────
    # Hash-named files are immutable — cache for 1 year
    location /_expo/ {
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /assets/ {
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /.well-known/ {
        try_files $uri =404;
    }

    # WASM files — same long cache, correct content type
    location ~* \.wasm$ {
        types { application/wasm wasm; }
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # SPA fallback — no cache on index.html (always fetch latest)
    location / {
        index index.html;
        try_files $uri $uri.html $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }

    error_page 404 = @spa_fallback;
    location @spa_fallback {
        rewrite ^ /index.html last;
    }
}
NGINX_EOF

    ok "Nginx config updated (proxy → static)"
else
    ok "Nginx already configured for static serving"
fi

# ── Step 4: Reload nginx & optional Docker cleanup ───────────────────────
step "4/4" "Reloading nginx"

ssh "${REMOTE_HOST}" "nginx -t 2>&1 && nginx -s reload"
ok "Nginx reloaded"

# Stop the old Docker webapp container if still running
DOCKER_WEBAPP=$(ssh "${REMOTE_HOST}" "docker ps -q --filter 'publish=9003'" 2>/dev/null || true)
if [[ -n "$DOCKER_WEBAPP" ]]; then
    warn "Old Docker webapp still running on :9003"
    info "Stopping container ${DOCKER_WEBAPP}..."
    ssh "${REMOTE_HOST}" "docker stop ${DOCKER_WEBAPP}"
    ok "Docker webapp container stopped"
    info "You can remove it later: ssh qc-sgp 'docker rm ${DOCKER_WEBAPP}'"
fi

# ── Summary ───────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Webapp deploy complete.${NC}"
echo -e "  Remote: ${REMOTE_HOST}:${REMOTE_WEB_ROOT}"
echo -e "  Files:  ${FILE_COUNT} files, ${DIST_SIZE} → tar ${TAR_SIZE}"
echo -e "  URL:    https://happy-web.sg.c1tas.pw"
