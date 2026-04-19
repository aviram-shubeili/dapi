import { join } from "node:path";
import { homedir } from "node:os";

export const BASE_DIR = join(homedir(), ".dapi");

/** Returns Unix socket path on Unix, or null on Windows (use TCP port file instead). */
export function socketPath(session: string): string {
  return join(BASE_DIR, `${session}.sock`);
}

export function pidFile(session: string): string {
  return join(BASE_DIR, `${session}.pid`);
}

/** Port file for TCP-based daemon communication (Windows fallback). */
export function portFile(session: string): string {
  return join(BASE_DIR, `${session}.port`);
}

export const USE_TCP = process.platform === "win32";
