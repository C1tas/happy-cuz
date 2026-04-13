import { execSync } from 'child_process';

/**
 * Get the current git commit hash (short form).
 * Returns undefined if git is not available or not in a git repo.
 */
export function getGitCommitHash(): string | undefined {
    try {
        return execSync('git rev-parse --short HEAD', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim() || undefined;
    } catch {
        return undefined;
    }
}
