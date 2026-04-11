#!/bin/bash
# Start happy-app web dev server pointing to local WSL server
# Usage: ./start-web.sh [server_url]

SERVER_URL="${1:-https://happy.sg.c1tas.pw}"

cd "$(dirname "$0")" || exit 1

export EXPO_PUBLIC_HAPPY_SERVER_URL="$SERVER_URL"

echo "Server: $EXPO_PUBLIC_HAPPY_SERVER_URL"
echo "Web:    http://192.168.58.1:8081"
echo ""

exec npx expo start --web --host lan
