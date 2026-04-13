import { homedir } from 'node:os';
import { join } from 'node:path';

export type Config = {
    serverUrl: string;
    homeDir: string;
    credentialPath: string;
};

export function loadConfig(): Config {
    const rawServerUrl = process.env.HAPPY_SERVER_URL;
    if (!rawServerUrl) {
        console.error('\x1b[31m\x1b[1m[FATAL]\x1b[0m HAPPY_SERVER_URL environment variable is not set.');
        console.error('  Export it before running happy-agent: export HAPPY_SERVER_URL=https://your-server.com');
        process.exit(1);
    }
    const serverUrl = rawServerUrl.replace(/\/+$/, '');
    const homeDir = process.env.HAPPY_HOME_DIR ?? join(homedir(), '.happy');
    const credentialPath = join(homeDir, 'agent.key');
    return { serverUrl, homeDir, credentialPath };
}
