#!/usr/bin/env bash
# restart.sh — Restart the current Happy dev environment
# Usage: ./restart.sh [--no-seed] [--logs] [--reset]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_DATA_DIR="$REPO_ROOT/environments/data"
CURRENT_FILE="$ENV_DATA_DIR/current.json"

# Parse args
NO_SEED=false
SHOW_LOGS=false
FULL_RESET=false
for arg in "$@"; do
    case "$arg" in
        --no-seed) NO_SEED=true ;;
        --logs)    SHOW_LOGS=true ;;
        --reset)   FULL_RESET=true ;;
        -h|--help)
            echo "Usage: ./restart.sh [--no-seed] [--logs] [--reset]"
            echo ""
            echo "  --no-seed   Skip auth seeding (use if already seeded)"
            echo "  --logs      Tail web server logs after startup"
            echo "  --reset     Delete environment data and recreate from scratch"
            exit 0
            ;;
    esac
done

# ── Full Reset ────────────────────────────────────────────────────────
if [ "$FULL_RESET" = true ]; then
    echo "==> Full reset: deleting all environment data..."

    # Stop everything
    yarn env:down 2>/dev/null || true
    pkill -f "expo start --web" 2>/dev/null || true
    pkill -f "happy-server standalone" 2>/dev/null || true
    pkill -f "happy daemon" 2>/dev/null || true
    sleep 2

    # Delete all environments
    rm -rf "$ENV_DATA_DIR/envs"/*
    rm -f "$CURRENT_FILE"
    echo "  All environment data deleted."

    # Detect WSL IP
    WSL_IP=$(ip addr show eth0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1 || echo "")
    if [ -n "$WSL_IP" ] && grep -qi microsoft /proc/version 2>/dev/null; then
        HOST_ADDR="$WSL_IP"
    else
        HOST_ADDR="localhost"
    fi

    # Create fresh environment skeleton
    echo ""
    echo "==> Creating fresh environment..."
    yarn env:new 2>&1 || true

    ENV_NAME=$(ls -t "$ENV_DATA_DIR/envs/" | head -1)
    ENV_DIR="$ENV_DATA_DIR/envs/$ENV_NAME"
    ENV_SH="$ENV_DIR/env.sh"

    if [ ! -f "$ENV_SH" ]; then
        echo "ERROR: Failed to create new environment"
        exit 1
    fi

    source "$ENV_SH"

    # Apply WSL overrides
    export EXPO_PUBLIC_HAPPY_SERVER_URL="http://${HOST_ADDR}:${PORT}"
    export EXPO_PUBLIC_SERVER_URL="http://${HOST_ADDR}:${PORT}"
    export HAPPY_SERVER_URL="http://${HOST_ADDR}:${PORT}"
    export HAPPY_WEBAPP_URL="http://${HOST_ADDR}:${EXPO_PORT}"
    export EXPO_PUBLIC_LOG_SERVER_URL=""

    # Ensure dirs
    mkdir -p "$DATA_DIR" "$PGLITE_DIR" "$HAPPY_HOME_DIR"
    mkdir -p "$ENV_DIR/server" "$ENV_DIR/web"

    # Ensure happy-wire is built
    if [ ! -f "$REPO_ROOT/packages/happy-wire/dist/index.mjs" ]; then
        yarn workspace @slopus/happy-wire build
    fi

    # Start server
    echo -n "Starting server on port $PORT..."
    yarn workspace happy-server standalone serve > "$ENV_DIR/server/stdout.log" 2>&1 &
    SERVER_PID=$!
    for i in $(seq 1 60); do
        curl -sf "http://localhost:$PORT/" > /dev/null 2>&1 && { echo " OK"; break; }
        kill -0 "$SERVER_PID" 2>/dev/null || { echo " FAILED"; cat "$ENV_DIR/server/stdout.log"; exit 1; }
        sleep 0.5
    done

    # Start web
    echo -n "Starting web on port $EXPO_PORT..."
    BROWSER=none yarn workspace happy-app web --port "$EXPO_PORT" --clear > "$ENV_DIR/web/stdout.log" 2>&1 &
    WEB_PID=$!
    for i in $(seq 1 120); do
        curl -sf "http://localhost:$EXPO_PORT/" > /dev/null 2>&1 && { echo " OK"; break; }
        kill -0 "$WEB_PID" 2>/dev/null || { echo " FAILED"; cat "$ENV_DIR/web/stdout.log"; exit 1; }
        sleep 0.5
    done

    # Seed auth
    echo -n "Seeding auth..."
    yarn env:seed 2>&1 | tail -3
    echo ""

    # Show summary
    CONFIG_FILE="$ENV_DIR/environment.json"
    AUTH_URL=$(python3 -c "
import json
c = json.load(open('$CONFIG_FILE'))
url = c.get('authenticatedWebUrl', 'http://${HOST_ADDR}:${EXPO_PORT}')
url = url.replace('localhost', '${HOST_ADDR}')
print(url)
" 2>/dev/null || echo "http://${HOST_ADDR}:${EXPO_PORT}")

    echo ""
    echo "============================================"
    echo "  Fresh environment \"$ENV_NAME\" is up!"
    echo "============================================"
    echo "  Server:  http://${HOST_ADDR}:${PORT}"
    echo "  Web:     http://${HOST_ADDR}:${EXPO_PORT}"
    echo "  Open:    $AUTH_URL"
    echo "  Stop:    yarn env:down"
    echo "============================================"

    if [ "$SHOW_LOGS" = true ]; then
        echo ""
        echo "Tailing web server logs (Ctrl-C to stop)..."
        tail -f "$ENV_DIR/web/stdout.log"
    fi
    exit 0
fi

# Read current environment (for non-reset mode)
if [ ! -f "$CURRENT_FILE" ]; then
    echo "No current environment found."
    echo "Create one first:  ./restart.sh --reset"
    exit 1
fi

ENV_NAME=$(python3 -c "import json; print(json.load(open('$CURRENT_FILE'))['current'])")
ENV_DIR="$ENV_DATA_DIR/envs/$ENV_NAME"
ENV_SH="$ENV_DIR/env.sh"

if [ ! -d "$ENV_DIR" ]; then
    echo "Environment directory not found: $ENV_DIR"
    exit 1
fi

if [ ! -f "$ENV_SH" ]; then
    echo "env.sh not found: $ENV_SH"
    echo "Re-generate with: yarn env:new"
    exit 1
fi

# Source the env.sh to get all correct variables
source "$ENV_SH"

# Detect WSL: if running under WSL, use the WSL eth0 IP so Windows browser
# can reach both the web app and the backend server.
WSL_IP=$(ip addr show eth0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1 || echo "")
if [ -n "$WSL_IP" ] && grep -qi microsoft /proc/version 2>/dev/null; then
    HOST_ADDR="$WSL_IP"
    echo "WSL detected, using host-accessible IP: $HOST_ADDR"
else
    HOST_ADDR="localhost"
fi

# Override server URLs so the browser (on Windows host) can reach the backend
# via the WSL IP instead of localhost (which would be Windows' own localhost)
export EXPO_PUBLIC_HAPPY_SERVER_URL="http://${HOST_ADDR}:${PORT}"
export EXPO_PUBLIC_SERVER_URL="http://${HOST_ADDR}:${PORT}"
export HAPPY_SERVER_URL="http://${HOST_ADDR}:${PORT}"
export HAPPY_WEBAPP_URL="http://${HOST_ADDR}:${EXPO_PORT}"

# Disable log server (not running by default, avoids ERR_CONNECTION_REFUSED spam)
export EXPO_PUBLIC_LOG_SERVER_URL=""

echo "Environment: $ENV_NAME"
echo "Server:      http://${HOST_ADDR}:${PORT}"
echo "Web:         http://${HOST_ADDR}:${EXPO_PORT}"
echo ""

# ── Stop ──────────────────────────────────────────────────────────────
echo "==> Stopping environment..."
yarn env:down 2>/dev/null || true
sleep 1

# ── Verify ports are free ────────────────────────────────────────────

# Verify ports are free
for port in "$PORT" "$EXPO_PORT"; do
    if lsof -i tcp:"$port" -sTCP:LISTEN -t 2>/dev/null | grep -q .; then
        echo "Port $port still in use, killing..."
        lsof -i tcp:"$port" -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
done

# ── Ensure directories exist ──────────────────────────────────────────
mkdir -p "$DATA_DIR"
mkdir -p "$PGLITE_DIR"
mkdir -p "$HAPPY_HOME_DIR"
mkdir -p "$ENV_DIR/server"
mkdir -p "$ENV_DIR/web"

# ── Ensure happy-wire is built ────────────────────────────────────────
if [ ! -f "$REPO_ROOT/packages/happy-wire/dist/index.mjs" ]; then
    echo "Building happy-wire..."
    yarn workspace @slopus/happy-wire build
fi

# ── Start Server ──────────────────────────────────────────────────────
echo ""
echo "==> Starting server..."

yarn workspace happy-server standalone serve > "$ENV_DIR/server/stdout.log" 2>&1 &
SERVER_PID=$!

# Wait for server health check
echo -n "Waiting for server..."
for i in $(seq 1 60); do
    if curl -sf "http://localhost:$PORT/" > /dev/null 2>&1; then
        echo " OK"
        break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo " FAILED"
        echo "--- Server log ---"
        cat "$ENV_DIR/server/stdout.log"
        exit 1
    fi
    sleep 0.5
done

# ── Start Web ─────────────────────────────────────────────────────────
echo ""
echo "==> Starting web..."

yarn workspace happy-app web --port "$EXPO_PORT" --clear > "$ENV_DIR/web/stdout.log" 2>&1 &
WEB_PID=$!

# Wait for web (Metro bundler takes longer)
echo -n "Waiting for web bundler..."
for i in $(seq 1 120); do
    if curl -sf "http://localhost:$EXPO_PORT/" > /dev/null 2>&1; then
        echo " OK"
        break
    fi
    if ! kill -0 "$WEB_PID" 2>/dev/null; then
        echo " FAILED"
        echo "--- Web log ---"
        cat "$ENV_DIR/web/stdout.log"
        exit 1
    fi
    sleep 0.5
done

# ── Verify HTML loads ─────────────────────────────────────────────────
echo ""
echo -n "Verifying web app HTML..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://${HOST_ADDR}:${EXPO_PORT}/")
if [ "$HTTP_CODE" = "200" ]; then
    echo " OK (HTTP $HTTP_CODE)"
else
    echo " WARNING (HTTP $HTTP_CODE, expected 200)"
fi

# ── Seed Auth ─────────────────────────────────────────────────────────
if [ "$NO_SEED" = false ]; then
    echo ""
    echo "==> Seeding auth..."
    yarn env:seed 2>&1 || echo "Warning: seed failed (may already be seeded)"
fi

# ── Summary ───────────────────────────────────────────────────────────
# Re-read config (seed may have updated it)
CONFIG_FILE="$ENV_DIR/environment.json"
AUTH_URL=$(python3 -c "
import json
c = json.load(open('$CONFIG_FILE'))
# Replace localhost with WSL IP if needed
url = c.get('authenticatedWebUrl', 'http://${HOST_ADDR}:${EXPO_PORT}')
url = url.replace('localhost', '${HOST_ADDR}')
print(url)
" 2>/dev/null || echo "http://${HOST_ADDR}:${EXPO_PORT}")

echo ""
echo "============================================"
echo "  Environment \"$ENV_NAME\" is up!"
echo "============================================"
echo "  Server:  http://${HOST_ADDR}:${PORT}"
echo "  Web:     http://${HOST_ADDR}:${EXPO_PORT}"
echo "  Open:    $AUTH_URL"
echo "  Logs:    $ENV_DIR/web/stdout.log"
echo "           $ENV_DIR/server/stdout.log"
echo ""
echo "  Stop:    yarn env:down"
echo "============================================"

# ── Tail Logs ─────────────────────────────────────────────────────────
if [ "$SHOW_LOGS" = true ]; then
    echo ""
    echo "Tailing web server logs (Ctrl-C to stop)..."
    tail -f "$ENV_DIR/web/stdout.log"
fi
