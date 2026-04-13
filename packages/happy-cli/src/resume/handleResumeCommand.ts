import { existsSync } from 'node:fs';
import React from 'react';
import { render } from 'ink';

import type { Metadata } from '@/api/types';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { ResumeOptionsSelector, type ResumeOptions } from '@/ui/ink/ResumeOptionsSelector';

import { resolveHappySession, type ResumableHappySession } from './resolveHappySession';

export type ResumeLaunch = {
    cwd: string;
    args: string[];
};

export type ResumeLaunchOptions = {
    claudeStartingMode?: 'local' | 'remote';
    startedBy?: 'daemon' | 'terminal';
    yolo?: boolean;
    remoteColor?: boolean;
    noAltScreen?: boolean;
    happySessionId?: string;
    dangerouslySkipPermissions?: boolean;
};

export function parseResumeCommandArgs(args: string[]): { showHelp: boolean; sessionId: string; skipMenu: boolean } {
    if (args.includes('-h') || args.includes('--help')) {
        return {
            showHelp: true,
            sessionId: '',
            skipMenu: false,
        };
    }

    const skipMenu = args.includes('--no-menu');
    const filtered = args.filter(a => a !== '--no-menu');

    if (filtered.length === 0) {
        throw new Error('Happy session ID is required: happy resume <session-id>');
    }
    if (filtered.length > 1) {
        throw new Error(`Unexpected arguments for happy resume: ${filtered.slice(1).join(' ')}`);
    }

    return {
        showHelp: false,
        sessionId: filtered[0],
        skipMenu,
    };
}

function resolveFlavor(metadata: Metadata): 'codex' | 'claude' | null {
    if (metadata.flavor === 'codex' || metadata.codexThreadId) {
        return 'codex';
    }
    if (metadata.flavor === 'claude' || metadata.claudeSessionId) {
        return 'claude';
    }
    return null;
}

export function buildResumeLaunch(session: ResumableHappySession, options: ResumeLaunchOptions = {}): ResumeLaunch {
    const { metadata } = session;
    const flavor = resolveFlavor(metadata);

    if (flavor === 'codex') {
        if (!metadata.codexThreadId) {
            throw new Error(`Happy session ${session.id} is missing its Codex thread ID.`);
        }
        const args = ['codex', '--resume', metadata.codexThreadId];
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        if (options.happySessionId) {
            args.push('--happy-session-id', options.happySessionId);
        }
        if (options.dangerouslySkipPermissions) {
            args.push('--dangerously-skip-permissions');
        }
        return {
            cwd: metadata.path,
            args,
        };
    }

    if (flavor === 'claude') {
        if (!metadata.claudeSessionId) {
            throw new Error(`Happy session ${session.id} is missing its Claude session ID.`);
        }
        const args = ['claude'];
        if (options.claudeStartingMode) {
            args.push('--happy-starting-mode', options.claudeStartingMode);
        }
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        if (options.yolo) {
            args.push('--yolo');
        }
        if (options.remoteColor) {
            args.push('--remote-color');
        }
        if (options.noAltScreen) {
            args.push('--no-alt-screen');
        }
        if (options.happySessionId) {
            args.push('--happy-session-id', options.happySessionId);
        }
        if (options.dangerouslySkipPermissions) {
            args.push('--dangerously-skip-permissions');
        }
        args.push('--resume', metadata.claudeSessionId);
        return {
            cwd: metadata.path,
            args,
        };
    }

    throw new Error(`Happy session ${session.id} uses unsupported flavor "${metadata.flavor ?? 'unknown'}".`);
}

export function formatResumeHelp(): string {
    return [
        'happy resume - Resume a previous Happy session',
        '',
        'Usage:',
        '  happy resume <happy-session-id>',
        '  happy resume <happy-session-id> --no-menu',
        '',
        'Options:',
        '  --no-menu    Skip interactive options menu and resume with defaults',
        '',
        'Examples:',
        '  happy resume cmmij8olq00dp5jcxr3wtbpau',
        '  happy resume cmmij8',
        '  happy resume cmmij8 --no-menu',
        '',
        'This reuses the saved worktree/path and resumes the underlying agent session',
        'when the backend supports it.',
    ].join('\n');
}

/**
 * Display interactive resume options selector and return user choices.
 * Returns null if user cancels.
 */
function selectResumeOptions(sessionId: string): Promise<ResumeOptions | null> {
    return new Promise((resolve) => {
        let hasResolved = false;

        const onSelect = (options: ResumeOptions) => {
            if (!hasResolved) {
                hasResolved = true;
                app.unmount();
                resolve(options);
            }
        };

        const onCancel = () => {
            if (!hasResolved) {
                hasResolved = true;
                app.unmount();
                resolve(null);
            }
        };

        const app = render(React.createElement(ResumeOptionsSelector, { sessionId, onSelect, onCancel }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    });
}

function spawnResumeChild(launch: ResumeLaunch): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawnHappyCLI(launch.args, {
            cwd: launch.cwd,
            env: process.env,
            stdio: 'inherit',
        });

        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`Resumed session exited via signal ${signal}`));
                return;
            }
            resolve(code);
        });
    });
}

export async function handleResumeCommand(args: string[]): Promise<void> {
    const parsed = parseResumeCommandArgs(args);
    if (parsed.showHelp) {
        console.log(formatResumeHelp());
        return;
    }

    const session = await resolveHappySession(parsed.sessionId);

    // Show interactive options menu unless --no-menu
    let launchOptions: ResumeLaunchOptions = {};
    if (!parsed.skipMenu && process.stdout.isTTY && process.stdin.isTTY) {
        const resumeOptions = await selectResumeOptions(session.id);
        if (!resumeOptions) {
            console.log('Resume cancelled.');
            return;
        }
        launchOptions = {
            claudeStartingMode: resumeOptions.startingMode,
            yolo: resumeOptions.yolo,
            remoteColor: resumeOptions.remoteColor,
            noAltScreen: resumeOptions.noAltScreen,
        };
    }

    // Always pass the happy session ID so the spawned process reconnects
    // to the same Happy session instead of creating a new one
    launchOptions.happySessionId = session.id;

    const launch = buildResumeLaunch(session, launchOptions);

    if (!existsSync(launch.cwd)) {
        throw new Error(`Saved session path does not exist: ${launch.cwd}`);
    }

    const exitCode = await spawnResumeChild(launch);
    if (typeof exitCode === 'number' && exitCode !== 0) {
        process.exit(exitCode);
    }
}
