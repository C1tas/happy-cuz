#!/usr/bin/env bash
set -euo pipefail

# Build standalone happy-server image (bun compiled binary + PGlite)
#
# Usage:
#   ./build-server-standalone.sh              # tags as happy-server-standalone:latest
#   ./build-server-standalone.sh my-tag       # tags as happy-server-standalone:my-tag

TAG="${1:-latest}"
IMAGE="happy-server-standalone:${TAG}"

echo "==> Building ${IMAGE} ..."
echo "    Dockerfile: Dockerfile.server-standalone"
echo "    Mode: standalone (PGlite embedded Postgres)"
echo ""

docker build \
    -f Dockerfile.server-standalone \
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
