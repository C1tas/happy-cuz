#!/usr/bin/env node
/**
 * StatusLine Wrapper for Claude Code
 *
 * Runs as Claude Code's statusLine command. Captures the stdin JSON that
 * Claude Code pipes in, writes key fields to a temp file for the CLI's
 * keepAlive to read, then optionally forwards stdin to the user's original
 * statusLine command.
 *
 * Environment variables:
 *   HAPPY_SESSION_ID - Happy session ID (required for file naming)
 *   HAPPY_ORIGINAL_STATUSLINE - Original statusLine command to forward to (optional)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sessionId = process.env.HAPPY_SESSION_ID;
const originalCmd = process.env.HAPPY_ORIGINAL_STATUSLINE;

function extractHudData(stdin) {
    const hud = {};

    if (stdin.model) {
        hud.model = stdin.model.display_name || stdin.model.id;
    }

    if (stdin.context_window) {
        const cw = stdin.context_window;
        if (cw.used_percentage !== undefined) {
            hud.contextPercent = Math.round(cw.used_percentage * 10) / 10;
        }
        if (cw.context_window_size) {
            hud.contextMax = cw.context_window_size;
        }
        if (cw.current_usage) {
            const u = cw.current_usage;
            hud.contextTokens = (u.input_tokens || 0) + (u.output_tokens || 0)
                + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        }
    }

    if (stdin.cost && stdin.cost.total_cost_usd !== undefined) {
        hud.costUsd = Math.round(stdin.cost.total_cost_usd * 10000) / 10000;
    }

    return hud;
}

// Read all of stdin
const chunks = [];
let stdinDone = false;

if (process.stdin.isTTY) {
    // No stdin available — just forward
    forwardToOriginal(Buffer.alloc(0));
} else {
    const timeout = setTimeout(() => {
        if (!stdinDone) {
            stdinDone = true;
            processStdin(Buffer.concat(chunks));
        }
    }, 500);

    process.stdin.on('data', (chunk) => {
        chunks.push(chunk);
    });

    process.stdin.on('end', () => {
        clearTimeout(timeout);
        if (!stdinDone) {
            stdinDone = true;
            processStdin(Buffer.concat(chunks));
        }
    });

    process.stdin.on('error', () => {
        clearTimeout(timeout);
        if (!stdinDone) {
            stdinDone = true;
            processStdin(Buffer.concat(chunks));
        }
    });

    process.stdin.resume();
}

function processStdin(buffer) {
    // Write HUD data to temp file
    if (sessionId && buffer.length > 0) {
        try {
            const stdinData = JSON.parse(buffer.toString('utf-8'));
            const hudData = extractHudData(stdinData);
            const filePath = path.join(os.tmpdir(), 'happy-hud-' + sessionId + '.json');
            const tmpPath = filePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(hudData));
            fs.renameSync(tmpPath, filePath);
        } catch (_) {
            // Ignore parse errors
        }
    }

    // Forward to original statusLine
    forwardToOriginal(buffer);
}

function forwardToOriginal(buffer) {
    if (!originalCmd) {
        process.exit(0);
        return;
    }

    const child = spawn('bash', ['-c', originalCmd], {
        stdio: ['pipe', 'inherit', 'inherit'],
    });

    if (buffer.length > 0) {
        child.stdin.write(buffer);
    }
    child.stdin.end();

    child.on('exit', (code) => {
        process.exit(code || 0);
    });

    child.on('error', () => {
        process.exit(0);
    });
}
