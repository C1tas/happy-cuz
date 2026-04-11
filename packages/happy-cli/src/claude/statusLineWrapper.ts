/**
 * StatusLine wrapper for Claude Code
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

import { writeFileSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface StdinData {
    model?: { id?: string; display_name?: string };
    context_window?: {
        context_window_size?: number;
        current_usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
        };
        used_percentage?: number;
    };
    cost?: {
        total_cost_usd?: number;
    };
    transcript_path?: string;
}

export interface SessionHudData {
    model?: string;
    contextPercent?: number;
    contextTokens?: number;
    contextMax?: number;
    costUsd?: number;
}

function extractHudData(stdin: StdinData): SessionHudData {
    const hud: SessionHudData = {};

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

    if (stdin.cost?.total_cost_usd !== undefined) {
        hud.costUsd = Math.round(stdin.cost.total_cost_usd * 10000) / 10000;
    }

    return hud;
}

export function getHudFilePath(sessionId: string): string {
    return join(tmpdir(), `happy-hud-${sessionId}.json`);
}

async function main(): Promise<void> {
    const sessionId = process.env.HAPPY_SESSION_ID;
    if (!sessionId) {
        // No session ID — just forward to original if available
        forwardToOriginal(Buffer.alloc(0));
        return;
    }

    // Read all of stdin
    const chunks: Buffer[] = [];
    let resolved = false;

    const stdinBuffer = await new Promise<Buffer>((resolve) => {
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve(Buffer.concat(chunks));
            }
        }, 500);

        if (process.stdin.isTTY) {
            clearTimeout(timeout);
            resolved = true;
            resolve(Buffer.alloc(0));
            return;
        }

        process.stdin.on('data', (chunk) => {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });

        process.stdin.on('end', () => {
            clearTimeout(timeout);
            if (!resolved) {
                resolved = true;
                resolve(Buffer.concat(chunks));
            }
        });

        process.stdin.on('error', () => {
            clearTimeout(timeout);
            if (!resolved) {
                resolved = true;
                resolve(Buffer.concat(chunks));
            }
        });

        process.stdin.resume();
    });

    // Parse and write HUD data
    if (stdinBuffer.length > 0) {
        try {
            const stdinData: StdinData = JSON.parse(stdinBuffer.toString('utf-8'));
            const hudData = extractHudData(stdinData);

            const filePath = getHudFilePath(sessionId);
            const tmpPath = filePath + '.tmp';
            writeFileSync(tmpPath, JSON.stringify(hudData));
            renameSync(tmpPath, filePath);
        } catch {
            // Ignore parse errors — don't break the statusLine pipeline
        }
    }

    // Forward to original statusLine
    forwardToOriginal(stdinBuffer);
}

function forwardToOriginal(stdinBuffer: Buffer): void {
    const originalCmd = process.env.HAPPY_ORIGINAL_STATUSLINE;
    if (!originalCmd) {
        process.exit(0);
        return;
    }

    const child = spawn('bash', ['-c', originalCmd], {
        stdio: ['pipe', 'inherit', 'inherit'],
    });

    if (stdinBuffer.length > 0) {
        child.stdin.write(stdinBuffer);
    }
    child.stdin.end();

    child.on('exit', (code) => {
        process.exit(code || 0);
    });

    child.on('error', () => {
        process.exit(0);
    });
}

main().catch(() => process.exit(0));
