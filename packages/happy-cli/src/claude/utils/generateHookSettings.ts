/**
 * Generate temporary settings file with Claude hooks for session tracking
 * and statusLine wrapper for HUD data capture.
 *
 * Creates a settings.json file that configures:
 * - SessionStart hook: notifies our HTTP server when sessions change
 * - statusLine: wrapper that captures Claude Code's stdin JSON for HUD reporting
 */

import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';

/**
 * Read the user's existing statusLine command from their Claude settings.
 * Returns the command string or undefined if not configured.
 */
function readUserStatusLine(): string | undefined {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPaths = [
        join(claudeDir, 'settings.local.json'),
        join(claudeDir, 'settings.json'),
    ];

    for (const settingsPath of settingsPaths) {
        try {
            if (!existsSync(settingsPath)) continue;
            const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
            if (data?.statusLine?.command) {
                return data.statusLine.command;
            }
        } catch {
            // Ignore parse errors
        }
    }
    return undefined;
}

/**
 * Generate a temporary settings file with SessionStart hook and statusLine wrapper
 *
 * @param port - The port where Happy server is listening
 * @param sessionId - The Happy session ID for HUD file naming
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number, sessionId?: string): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    // Path to the hook forwarder script
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const hookCommand = `node "${forwarderScript}" ${port}`;

    const settings: Record<string, unknown> = {
        hooks: {
            SessionStart: [
                {
                    matcher: "*",
                    hooks: [
                        {
                            type: "command",
                            command: hookCommand
                        }
                    ]
                }
            ]
        }
    };

    // Add statusLine wrapper for HUD data capture
    if (sessionId) {
        const wrapperScript = resolve(projectPath(), 'scripts', 'status_line_wrapper.cjs');
        const originalStatusLine = readUserStatusLine();

        // Build wrapper command with env vars
        const envParts = [`HAPPY_SESSION_ID=${sessionId}`];
        if (originalStatusLine) {
            // Escape single quotes in the original command for safe embedding
            const escaped = originalStatusLine.replace(/'/g, "'\\''");
            envParts.push(`HAPPY_ORIGINAL_STATUSLINE='${escaped}'`);
        }
        const wrapperCommand = `${envParts.join(' ')} node "${wrapperScript}"`;

        settings.statusLine = {
            type: 'command',
            command: wrapperCommand
        };
        logger.debug(`[generateHookSettings] StatusLine wrapper configured for session ${sessionId}`);
    }

    writeFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created hook settings file: ${filepath}`);

    return filepath;
}

/**
 * Clean up the temporary hook settings file
 * 
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}

