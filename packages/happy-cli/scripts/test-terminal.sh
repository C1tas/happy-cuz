#!/bin/bash
# Terminal behavior test for remote mode
# Captures terminal state before and after running happy CLI to detect corruption.
#
# Usage:
#   HAPPY_TERMINAL_DEBUG=1 ./scripts/test-terminal.sh
#
# After running, the script launches happy CLI. Use it normally, then exit.
# The script compares pre/post terminal state and reports differences.

set -e

LOG_DIR="/tmp/happy-terminal-test-$(date +%s)"
mkdir -p "$LOG_DIR"

echo "=== Happy CLI Terminal Test Suite ==="
echo "Log dir: $LOG_DIR"
echo ""

# Record initial terminal state
echo "[PRE] Recording initial terminal state..."
tput cols > "$LOG_DIR/initial-cols.txt" 2>&1 || true
tput lines > "$LOG_DIR/initial-lines.txt" 2>&1 || true
stty -a > "$LOG_DIR/initial-stty.txt" 2>&1 || true
echo "  cols=$(cat "$LOG_DIR/initial-cols.txt"), lines=$(cat "$LOG_DIR/initial-lines.txt")"

# Run happy CLI — user interacts and exits manually
echo ""
echo "[TEST] Starting happy CLI (exit normally when done)..."
echo "  Debug logging: ${HAPPY_TERMINAL_DEBUG:-off}"
echo ""

# Find the happy binary
HAPPY_BIN="${HAPPY_BIN:-$(dirname "$0")/../bin/happy.mjs}"
if [ ! -f "$HAPPY_BIN" ]; then
    echo "ERROR: happy binary not found at $HAPPY_BIN"
    echo "Set HAPPY_BIN env var or run from packages/happy-cli directory"
    exit 1
fi

# Run happy (user exits manually)
"$HAPPY_BIN" "$@" || true

# Record post-exit terminal state
echo ""
echo "[POST] Recording post-exit terminal state..."
tput cols > "$LOG_DIR/final-cols.txt" 2>&1 || true
tput lines > "$LOG_DIR/final-lines.txt" 2>&1 || true
stty -a > "$LOG_DIR/final-stty.txt" 2>&1 || true
echo "  cols=$(cat "$LOG_DIR/final-cols.txt"), lines=$(cat "$LOG_DIR/final-lines.txt")"

# Compare
echo ""
echo "=== Results ==="

if diff -q "$LOG_DIR/initial-stty.txt" "$LOG_DIR/final-stty.txt" > /dev/null 2>&1; then
    echo "PASS: stty settings unchanged"
else
    echo "FAIL: stty settings changed"
    diff "$LOG_DIR/initial-stty.txt" "$LOG_DIR/final-stty.txt" || true
fi

if diff -q "$LOG_DIR/initial-cols.txt" "$LOG_DIR/final-cols.txt" > /dev/null 2>&1; then
    echo "PASS: terminal columns unchanged"
else
    echo "WARN: terminal columns changed ($(cat "$LOG_DIR/initial-cols.txt") -> $(cat "$LOG_DIR/final-cols.txt"))"
fi

# Check for debug log
DEBUG_LOG=$(ls /tmp/happy-terminal-debug-*.log 2>/dev/null | tail -1)
if [ -n "$DEBUG_LOG" ]; then
    echo ""
    echo "Debug log: $DEBUG_LOG"
    echo "--- Last 10 lines ---"
    tail -10 "$DEBUG_LOG"
fi

echo ""
echo "Test artifacts: $LOG_DIR"
