/**
 * Terminal capability detection for adaptive escape sequence usage.
 *
 * Probes environment variables (TERM, WT_SESSION, TMUX, STY, TERM_PROGRAM, etc.)
 * to determine which escape sequences the hosting terminal actually supports.
 * This avoids sending unsupported sequences that cause garbled output or are
 * silently swallowed (e.g. DECSTR in GNU screen, \x1b[3J in tmux).
 */

import { execSync } from "node:child_process";

export interface TerminalCapabilities {
    /** Alternate screen buffer (\x1b[?1049h / \x1b[?1049l) */
    altScreen: boolean
    /** Clear scrollback buffer (\x1b[3J) — only modern terminals */
    clearScrollback: boolean
    /** DECSTR soft terminal reset (\x1b[!p) — narrow support */
    decstr: boolean
    /** Cursor positioning and visibility (\x1b[H, \x1b[?25h) */
    cursorControl: boolean
    /** SGR attribute reset and basic colors (\x1b[0m, \x1b[2J) */
    sgr: boolean
    /** DEC 2026 Synchronized Update — atomic BSU/ESU blocks for flicker-free redraws */
    synchronizedUpdate: boolean
}

/**
 * DEC private mode constants for structured terminal control.
 * Use these instead of hardcoded escape sequences throughout the codebase.
 */
export const DEC = {
    /** Enter alternate screen buffer */
    ENTER_ALT_SCREEN: '\x1b[?1049h',
    /** Leave alternate screen buffer */
    EXIT_ALT_SCREEN: '\x1b[?1049l',
    /** Begin Synchronized Update (DEC 2026) — terminal buffers all output until ESU */
    BSU: '\x1b[?2026h',
    /** End Synchronized Update (DEC 2026) — terminal flushes buffered output atomically */
    ESU: '\x1b[?2026l',
    /** Show cursor */
    SHOW_CURSOR: '\x1b[?25h',
    /** Hide cursor */
    HIDE_CURSOR: '\x1b[?25l',
    /** Cursor home (top-left) */
    CURSOR_HOME: '\x1b[H',
    /** Clear visible screen */
    CLEAR_SCREEN: '\x1b[2J',
    /** Clear scrollback buffer */
    CLEAR_SCROLLBACK: '\x1b[3J',
    /** Reset SGR attributes */
    SGR_RESET: '\x1b[0m',
} as const

/**
 * Build the optimal terminal reset escape sequence for the detected capabilities.
 * Used when fully exiting remote mode (back to shell). Clears the screen
 * but intentionally does NOT clear scrollback — destroying terminal history
 * is disruptive after alt screen exit (main buffer is already restored).
 * Returns an empty string if no sequences are supported.
 */
export function buildTerminalResetSequence(caps: TerminalCapabilities): string {
    let seq = ''
    if (caps.cursorControl) seq += DEC.CURSOR_HOME
    if (caps.sgr) seq += DEC.CLEAR_SCREEN
    if (caps.cursorControl) seq += DEC.SHOW_CURSOR
    if (caps.sgr) seq += DEC.SGR_RESET
    return seq
}

/**
 * Build a lightweight terminal reset for mode transitions (remote → local).
 * Does NOT clear the screen or scrollback — only resets SGR attributes and
 * restores cursor visibility. The child process (Claude Code) will set up
 * its own terminal state via tcsetattr when it starts.
 */
export function buildTransitionResetSequence(caps: TerminalCapabilities): string {
    let seq = ''
    if (caps.cursorControl) seq += DEC.SHOW_CURSOR
    if (caps.sgr) seq += DEC.SGR_RESET
    return seq
}

/**
 * Detect if running inside tmux control mode (-CC).
 * Control mode does not support alternate screen or most escape sequences.
 * Uses a synchronous subprocess probe — safe to call at startup.
 */
function isTmuxControlMode(): boolean {
    try {
        const result = execSync('tmux display-message -p "#{client_control_mode}"', {
            timeout: 2000,
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8'
        }).trim()
        return result === '1'
    } catch {
        return false
    }
}

/**
 * Detect terminal capabilities from environment variables.
 *
 * Uses environment-based heuristics plus a tmux -CC sync probe when applicable.
 * Safe to call at any point — does not send escape sequences to the terminal.
 */
export function detectTerminalCapabilities(): TerminalCapabilities {
    const isTTY = process.stdout.isTTY && process.stdin.isTTY

    if (!isTTY) {
        return { altScreen: false, clearScrollback: false, decstr: false, cursorControl: false, sgr: false, synchronizedUpdate: false }
    }

    const term = (process.env.TERM ?? '').toLowerCase()
    const noColor = process.env.NO_COLOR !== undefined

    // dumb terminal or explicit no-color: nothing is safe
    if (term === 'dumb' || noColor) {
        return { altScreen: false, clearScrollback: false, decstr: false, cursorControl: false, sgr: false, synchronizedUpdate: false }
    }

    // tmux: supports alt screen and basic ANSI, but does NOT forward \x1b[3J or DECSTR reliably
    // DEC 2026 synchronized update IS supported in tmux 3.3+ but we conservatively disable it
    // tmux -CC (control mode) does not support alt screen at all
    if (process.env.TMUX) {
        const controlMode = isTmuxControlMode()
        return {
            altScreen: !controlMode,
            clearScrollback: false,
            decstr: false,
            cursorControl: !controlMode,
            sgr: !controlMode,
            synchronizedUpdate: false
        }
    }

    // GNU screen: similar to tmux but even less feature support
    if (process.env.STY) {
        return { altScreen: true, clearScrollback: false, decstr: false, cursorControl: true, sgr: true, synchronizedUpdate: false }
    }

    // Windows Terminal (via WSL): full support including scrollback clear, DECSTR, and DEC 2026
    if (process.env.WT_SESSION) {
        return { altScreen: true, clearScrollback: true, decstr: true, cursorControl: true, sgr: true, synchronizedUpdate: true }
    }

    // Known modern terminal emulators (via TERM_PROGRAM)
    const termProgram = (process.env.TERM_PROGRAM ?? '').toLowerCase()
    if (termProgram === 'vscode' || termProgram === 'iterm.app' || termProgram === 'hyper'
        || termProgram === 'alacritty' || termProgram === 'wezterm' || termProgram === 'kitty') {
        return { altScreen: true, clearScrollback: true, decstr: false, cursorControl: true, sgr: true, synchronizedUpdate: true }
    }

    // xterm variants (xterm, xterm-256color, xterm-kitty, rxvt, etc.)
    if (/^(xterm|rxvt|alacritty|kitty)/.test(term)) {
        return { altScreen: true, clearScrollback: true, decstr: false, cursorControl: true, sgr: true, synchronizedUpdate: true }
    }

    // vt100 / vt220: cursor control works, but no alt screen
    if (/^vt\d+/.test(term)) {
        return { altScreen: false, clearScrollback: false, decstr: false, cursorControl: true, sgr: true, synchronizedUpdate: false }
    }

    // Default for unknown terminals with TTY: conservative — assume basic ANSI
    return { altScreen: true, clearScrollback: false, decstr: false, cursorControl: true, sgr: true, synchronizedUpdate: false }
}

/**
 * Build a terminal mode reassertion sequence for recovery after state loss.
 *
 * Scenarios where terminal state is lost:
 * - tmux detach/reattach
 * - SSH reconnect
 * - Laptop sleep/wake
 * - Terminal window resize (SIGWINCH)
 * - Process foregrounded after SIGTSTP (SIGCONT)
 *
 * @param caps Detected terminal capabilities
 * @param inAltScreen Whether we expect to be in alternate screen mode
 */
export function buildReassertSequence(caps: TerminalCapabilities, inAltScreen: boolean): string {
    let seq = ''
    // Re-enter alt screen if we should be in it
    if (inAltScreen && caps.altScreen) seq += DEC.ENTER_ALT_SCREEN
    // Restore cursor visibility
    if (caps.cursorControl) seq += DEC.SHOW_CURSOR
    // Reset SGR so colors don't bleed
    if (caps.sgr) seq += DEC.SGR_RESET
    return seq
}
