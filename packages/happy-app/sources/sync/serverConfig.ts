import { MMKV } from "react-native-mmkv";

// Separate MMKV instance for server config that persists across logouts
const serverConfigStorage = new MMKV({ id: "server-config" });

const SERVER_KEY = "custom-server-url";
const LOG_SERVER_KEY = "log-server-url";
// Build-time default — MUST be set via EXPO_PUBLIC_HAPPY_SERVER_URL at build time
const BUILD_DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;

export function getServerUrl(): string {
  const stored = serverConfigStorage.getString(SERVER_KEY);
  if (stored) return stored;
  if (BUILD_DEFAULT_SERVER_URL) return BUILD_DEFAULT_SERVER_URL;
  console.error(
    "[FATAL] EXPO_PUBLIC_HAPPY_SERVER_URL is not set. Set it at build time.",
  );
  process.exit(1);
  return "";
}

export function setServerUrl(url: string | null): void {
  if (url && url.trim()) {
    serverConfigStorage.set(SERVER_KEY, url.trim());
  } else {
    serverConfigStorage.delete(SERVER_KEY);
  }
}

export function getLogServerUrl(): string | null {
  return (
    serverConfigStorage.getString(LOG_SERVER_KEY) ||
    process.env.EXPO_PUBLIC_LOG_SERVER_URL ||
    null
  );
}

export function setLogServerUrl(url: string | null): void {
  if (url && url.trim()) {
    serverConfigStorage.set(LOG_SERVER_KEY, url.trim());
  } else {
    serverConfigStorage.delete(LOG_SERVER_KEY);
  }
}

export function isUsingCustomServer(): boolean {
  const stored = serverConfigStorage.getString(SERVER_KEY);
  return !!stored && stored !== BUILD_DEFAULT_SERVER_URL;
}

export function getServerInfo(): {
  hostname: string;
  port?: number;
  isCustom: boolean;
} {
  const url = getServerUrl();
  const isCustom = isUsingCustomServer();

  try {
    const parsed = new URL(url);
    const port = parsed.port ? parseInt(parsed.port) : undefined;
    return {
      hostname: parsed.hostname,
      port,
      isCustom,
    };
  } catch {
    // Fallback if URL parsing fails
    return {
      hostname: url,
      port: undefined,
      isCustom,
    };
  }
}

export function validateServerUrl(url: string): {
  valid: boolean;
  error?: string;
} {
  if (!url || !url.trim()) {
    return { valid: false, error: "Server URL cannot be empty" };
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        valid: false,
        error: "Server URL must use HTTP or HTTPS protocol",
      };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
}
