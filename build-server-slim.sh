#!/usr/bin/env bash
set -euo pipefail

# Build optimized happy-server image (production deps only)
#
# Usage:
#   ./build-server-slim.sh              # tags as happy-server-slim:latest
#   ./build-server-slim.sh my-tag       # tags as happy-server-slim:my-tag

TAG="${1:-latest}"
IMAGE="happy-server-slim:${TAG}"

echo "==> Building ${IMAGE} ..."
echo "    Dockerfile: Dockerfile.server-slim"
echo ""

docker build \
    -f Dockerfile.server-slim \
    -t "${IMAGE}" \
    .

echo ""
echo "==> Build complete: ${IMAGE}"
echo ""

# Show size comparison
printf "%-40s %s\n" "IMAGE" "SIZE"
printf "%-40s %s\n" "-----" "----"
printf "%-40s %s\n" "${IMAGE}" "$(docker image inspect "${IMAGE}" --format '{{.Size}}' | numfmt --to=iec-i --suffix=B 2>/dev/null || docker image ls "${IMAGE}" --format '{{.Size}}')"

if docker image inspect happy-server:latest >/dev/null 2>&1; then
    ORIG_SIZE=$(docker image inspect happy-server:latest --format '{{.Size}}' | numfmt --to=iec-i --suffix=B 2>/dev/null || docker image ls happy-server:latest --format '{{.Size}}')
    printf "%-40s %s\n" "happy-server:latest (original)" "${ORIG_SIZE}"

    NEW_BYTES=$(docker image inspect "${IMAGE}" --format '{{.Size}}')
    ORIG_BYTES=$(docker image inspect happy-server:latest --format '{{.Size}}')
    if [ "${ORIG_BYTES}" -gt 0 ]; then
        REDUCTION=$(( (ORIG_BYTES - NEW_BYTES) * 100 / ORIG_BYTES ))
        echo ""
        echo "    Size reduction: ${REDUCTION}%"
    fi
fi
