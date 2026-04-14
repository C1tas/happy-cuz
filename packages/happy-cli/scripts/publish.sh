#!/usr/bin/env bash
# publish.sh — Build and publish happy-cuz to npm
#
# Usage:
#   ./scripts/publish.sh              # build + publish (auto-bumps patch if version exists)
#   ./scripts/publish.sh --unpublish  # unpublish current version then republish (requires OTP)
#   ./scripts/publish.sh --dry-run    # build only, show what would be published
#
# Flow:
#   1. Build (tsc --noEmit && pkgroll)
#   2. Try npm publish
#   3. If version already exists on registry:
#      - Default: auto-bump patch version, commit, retry publish
#      - With --unpublish: npm unpublish old version (prompts for OTP), then republish
#   4. Commit version bump if one was made

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

# Parse args
MODE="auto"       # auto | unpublish | dry-run
OTP=""
for arg in "$@"; do
    case "$arg" in
        --unpublish) MODE="unpublish" ;;
        --dry-run)   MODE="dry-run" ;;
        --otp=*)     OTP="${arg#--otp=}" ;;
        *)           echo "Unknown argument: $arg"; echo "Usage: $0 [--unpublish] [--dry-run] [--otp=CODE]"; exit 1 ;;
    esac
done

cd "$PKG_DIR"

# Read package info
PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")

echo "=== $PKG_NAME@$PKG_VERSION ==="
echo ""

# Step 1: Build
echo "[1/3] Building..."
yarn build
echo "  Build OK"
echo ""

if [[ "$MODE" == "dry-run" ]]; then
    echo "[dry-run] Would publish $PKG_NAME@$PKG_VERSION"
    npm pack --dry-run 2>&1 | tail -5
    exit 0
fi

# Step 2: Check if version exists on registry
check_version_exists() {
    local ver="$1"
    npm view "$PKG_NAME@$ver" version 2>/dev/null && return 0 || return 1
}

# Step 3: Publish
do_publish() {
    local otp_flag=""
    if [[ -n "$OTP" ]]; then
        otp_flag="--otp=$OTP"
    fi
    # shellcheck disable=SC2086
    npm publish --ignore-scripts $otp_flag 2>&1
}

if [[ "$MODE" == "unpublish" ]]; then
    # Unpublish + republish flow
    if check_version_exists "$PKG_VERSION"; then
        echo "[2/3] Unpublishing $PKG_NAME@$PKG_VERSION..."
        if [[ -z "$OTP" ]]; then
            echo "  OTP required for unpublish. Provide via --otp=CODE or enter below:"
            read -rp "  OTP: " OTP
        fi
        npm unpublish "$PKG_NAME@$PKG_VERSION" --force --otp="$OTP" 2>&1
        echo "  Unpublished. Waiting 5s for registry propagation..."
        sleep 5
    fi
    echo "[3/3] Publishing $PKG_NAME@$PKG_VERSION..."
    do_publish
    echo ""
    echo "Published $PKG_NAME@$PKG_VERSION"
else
    # Auto-bump flow
    echo "[2/3] Publishing $PKG_NAME@$PKG_VERSION..."
    if check_version_exists "$PKG_VERSION"; then
        echo "  Version $PKG_VERSION already exists on registry."
        echo "  Auto-bumping patch version..."

        # Bump patch version (no git tag)
        npm version patch --no-git-tag-version >/dev/null 2>&1
        NEW_VERSION=$(node -p "require('./package.json').version")
        echo "  Bumped: $PKG_VERSION -> $NEW_VERSION"

        # Commit the version bump
        cd "$REPO_ROOT"
        git add "$PKG_DIR/package.json" yarn.lock 2>/dev/null || true
        git commit -m "chore(cli): bump version to $NEW_VERSION for npm publish" >/dev/null 2>&1
        echo "  Committed version bump"
        cd "$PKG_DIR"

        PKG_VERSION="$NEW_VERSION"
    fi

    echo "[3/3] Publishing $PKG_NAME@$PKG_VERSION..."
    do_publish
    echo ""
    echo "Published $PKG_NAME@$PKG_VERSION"
fi

echo ""
echo "Install: npm i -g $PKG_NAME@$PKG_VERSION"
