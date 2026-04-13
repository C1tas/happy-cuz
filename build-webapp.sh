#!/usr/bin/env bash
set -euo pipefail

# Build happy-webapp image (Expo web export + Nginx)
#
# Usage:
#   ./build-webapp.sh                    # tags as happy-webapp:latest
#   ./build-webapp.sh my-tag             # tags as happy-webapp:my-tag
#
# Build args (from environment):
#   POSTHOG_API_KEY       — PostHog analytics key
#   REVENUE_CAT_STRIPE    — RevenueCat Stripe integration key

TAG="${1:-latest}"
IMAGE="happy-webapp:${TAG}"

echo "==> Building ${IMAGE} ..."
echo "    Dockerfile: Dockerfile.webapp"
echo "    Mode: webapp (Expo web + Nginx)"

BUILD_ARGS=()
if [[ -n "${POSTHOG_API_KEY:-}" ]]; then
    BUILD_ARGS+=(--build-arg "POSTHOG_API_KEY=${POSTHOG_API_KEY}")
    echo "    POSTHOG_API_KEY: set"
fi
if [[ -n "${REVENUE_CAT_STRIPE:-}" ]]; then
    BUILD_ARGS+=(--build-arg "REVENUE_CAT_STRIPE=${REVENUE_CAT_STRIPE}")
    echo "    REVENUE_CAT_STRIPE: set"
fi
echo ""

docker build \
    -f Dockerfile.webapp \
    "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}" \
    -t "${IMAGE}" \
    .

echo ""
echo "==> Build complete: ${IMAGE}"
echo ""

# Show image size
printf "%-40s %s\n" "IMAGE" "SIZE"
printf "%-40s %s\n" "-----" "----"
printf "%-40s %s\n" "${IMAGE}" "$(docker image inspect "${IMAGE}" --format '{{.Size}}' | numfmt --to=iec-i --suffix=B 2>/dev/null || docker image ls "${IMAGE}" --format '{{.Size}}')"
