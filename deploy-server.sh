#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# deploy-server.sh — Build, transfer, and deploy to qc-sgp
#
# Usage:
#   ./deploy-server.sh slim          # Build slim image and deploy
#   ./deploy-server.sh standalone    # Build standalone image and deploy
#   ./deploy-server.sh webapp        # Build webapp image and deploy
#   ./deploy-server.sh slim v2       # Build with custom tag
#
# Flow:
#   1. Build Docker image locally (slim, standalone, or webapp)
#   2. docker save → /tmp/happy.tar
#   3. scp tar to jump host (192.168.58.120:/root/share/)
#   4. ssh qc-sgp: wget tar from jump host HTTP
#   5. ssh qc-sgp: docker load
#   6. ssh qc-sgp: docker compose up -d
#   7. Verify remote image hash matches local build
#   8. Run local_update.sh to rebuild CLI/agent and restart daemon (server modes only)

# ── Config ─────────────────────────────────────────────────────────────────
REMOTE_HOST="qc-sgp"
JUMP_HOST="root@192.168.58.120"
JUMP_SHARE_DIR="/root/share"
JUMP_HTTP_URL="http://183.222.16.203:57878"
REMOTE_HAPPY_DIR="/root/happy"
TAR_FILE="happy.tar"
LOCAL_TAR="/tmp/${TAR_FILE}"

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

# ── Args ───────────────────────────────────────────────────────────────────
MODE="${1:-}"
TAG="${2:-latest}"

if [[ "$MODE" != "slim" && "$MODE" != "standalone" && "$MODE" != "webapp" ]]; then
    echo "Usage: $0 <slim|standalone|webapp> [tag]"
    echo ""
    echo "  slim        — Production deps only (smaller image)"
    echo "  standalone  — Bun compiled binary + PGlite (self-contained)"
    echo "  webapp      — Expo web app + Nginx"
    echo ""
    echo "  tag         — Docker image tag (default: latest)"
    exit 1
fi

case "$MODE" in
    slim)
        IMAGE="happy-server-slim:${TAG}"
        BUILD_SCRIPT="./build-server-slim.sh"
        ;;
    standalone)
        IMAGE="happy-server-standalone:${TAG}"
        BUILD_SCRIPT="./build-server-standalone.sh"
        ;;
    webapp)
        IMAGE="happy-webapp:${TAG}"
        BUILD_SCRIPT="./build-webapp.sh"
        ;;
esac

echo -e "${BOLD}Deploying ${GREEN}${IMAGE}${NC}${BOLD} to ${CYAN}${REMOTE_HOST}${NC}"
echo -e "${DIM}  mode: ${MODE}, tag: ${TAG}${NC}"

# ── Step 1: Build ──────────────────────────────────────────────────────────
step "1/7" "Building Docker image"

if [[ ! -x "$BUILD_SCRIPT" ]]; then
    fail "Build script not found: ${BUILD_SCRIPT}"
    exit 1
fi

"$BUILD_SCRIPT" "$TAG"
ok "Image built: ${IMAGE}"

LOCAL_IMAGE_ID=$(docker image inspect "${IMAGE}" --format '{{.Id}}')
LOCAL_IMAGE_SIZE=$(docker image inspect "${IMAGE}" --format '{{.Size}}' | numfmt --to=iec-i --suffix=B 2>/dev/null || docker image ls "${IMAGE}" --format '{{.Size}}')
info "Image ID:   ${DIM}${LOCAL_IMAGE_ID}${NC}"
info "Image size: ${DIM}${LOCAL_IMAGE_SIZE}${NC}"

# ── Step 2: Save to tar ───────────────────────────────────────────────────
step "2/7" "Saving image to ${LOCAL_TAR}"

docker save "${IMAGE}" -o "${LOCAL_TAR}"
TAR_SIZE=$(du -h "${LOCAL_TAR}" | cut -f1)
ok "Saved: ${LOCAL_TAR} (${TAR_SIZE})"

# ── Step 3: SCP to jump host ──────────────────────────────────────────────
step "3/7" "Uploading to jump host (${JUMP_HOST})"

info "scp ${LOCAL_TAR} → ${JUMP_HOST}:${JUMP_SHARE_DIR}/${TAR_FILE}"
scp "${LOCAL_TAR}" "${JUMP_HOST}:${JUMP_SHARE_DIR}/${TAR_FILE}"
ok "Uploaded to jump host"

# ── Step 4: Download on remote ────────────────────────────────────────────
step "4/7" "Downloading on ${REMOTE_HOST} via HTTP"

info "wget ${JUMP_HTTP_URL}/${TAR_FILE} → ${REMOTE_HAPPY_DIR}/${TAR_FILE}"
ssh "${REMOTE_HOST}" "cd ${REMOTE_HAPPY_DIR} && rm -f ${TAR_FILE} && wget --user bdsec --password ensec123 -nv -o /dev/stderr ${JUMP_HTTP_URL}/${TAR_FILE}" 2>&1 | while IFS= read -r line; do
    echo -e "  ${DIM}${line}${NC}"
done
ok "Downloaded on remote"

# ── Step 5: Load image on remote ──────────────────────────────────────────
step "5/7" "Loading Docker image on ${REMOTE_HOST}"

ssh "${REMOTE_HOST}" "docker load -i ${REMOTE_HAPPY_DIR}/${TAR_FILE}"
ok "Image loaded"

# Clean up remote tar
ssh "${REMOTE_HOST}" "rm -f ${REMOTE_HAPPY_DIR}/${TAR_FILE}"
info "Cleaned up remote tar"

# ── Step 6: Deploy + verify ───────────────────────────────────────────────
step "6/7" "Deploying and verifying on ${REMOTE_HOST}"

info "docker compose up -d"
ssh "${REMOTE_HOST}" "cd ${REMOTE_HAPPY_DIR} && docker compose up -d"

# Verify image hash
REMOTE_IMAGE_ID=$(ssh "${REMOTE_HOST}" "docker image inspect ${IMAGE} --format '{{.Id}}'" 2>/dev/null || echo "NOT_FOUND")

echo ""
echo -e "${BOLD}Verification${NC}"
info "Local  image ID: ${DIM}${LOCAL_IMAGE_ID}${NC}"
info "Remote image ID: ${DIM}${REMOTE_IMAGE_ID}${NC}"

if [[ "${LOCAL_IMAGE_ID}" == "${REMOTE_IMAGE_ID}" ]]; then
    ok "${GREEN}Image hash match confirmed${NC}"
else
    fail "Image hash MISMATCH!"
    fail "  Local:  ${LOCAL_IMAGE_ID}"
    fail "  Remote: ${REMOTE_IMAGE_ID}"
    exit 1
fi

# Clean up local tar
rm -f "${LOCAL_TAR}"
info "Cleaned up local tar"

# ── Step 7: Local daemon update (server modes only) ──────────────────────
if [[ "$MODE" != "webapp" ]]; then
    step "7/7" "Updating local CLI/agent and restarting daemon"
    ./local_update.sh
else
    step "7/7" "Skipped (webapp mode — no local daemon update needed)"
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Full deploy complete.${NC}"
echo -e "  Image:  ${IMAGE}"
echo -e "  Hash:   ${LOCAL_IMAGE_ID:0:24}..."
echo -e "  Remote: ${REMOTE_HOST}:${REMOTE_HAPPY_DIR}"
if [[ "$MODE" != "webapp" ]]; then
    echo -e "  Local:  daemon updated via local_update.sh"
fi
