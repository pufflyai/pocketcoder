// Owns managed server identity and its local process state.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ServerState {
  version: 1;
  pid: number;
  instanceToken: string;
  url: string;
  startedAt: string;
  configFingerprint: string;
  logPath: string;
}

export function stateRoot(): string {
  return resolve(process.env.POCKETCODER_STATE_DIR ?? join(homedir(), ".local", "state", "pocketcoder"));
}

function statePath(): string {
  return join(stateRoot(), "server.json");
}

export function logPath(): string {
  return join(stateRoot(), "server.log");
}

function stateFromJson(value: unknown): ServerState | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<ServerState>;
  if (
    row.version !== 1 ||
    typeof row.pid !== "number" ||
    !Number.isSafeInteger(row.pid) ||
    row.pid <= 0 ||
    typeof row.instanceToken !== "string" ||
    typeof row.url !== "string" ||
    typeof row.startedAt !== "string" ||
    typeof row.configFingerprint !== "string" ||
    typeof row.logPath !== "string"
  ) {
    return null;
  }
  return row as ServerState;
}

export function readState(): ServerState | null {
  try {
    return stateFromJson(JSON.parse(readFileSync(statePath(), "utf8")));
  } catch {
    return null;
  }
}

export function writeState(state: ServerState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function removeState(): void {
  rmSync(statePath(), { force: true });
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommand(pid: number): string | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.status !== 0) return null;
  const command = result.stdout.trim();
  return command || null;
}

export function processIdentityMatches(state: ServerState): boolean {
  if (!processExists(state.pid)) return false;
  return processCommand(state.pid)?.includes(state.instanceToken) ?? false;
}

export async function readOwnedState(): Promise<ServerState> {
  const root = stateRoot();
  const parent = await lstat(root);
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o777) !== 0o700 ||
    (await realpath(root)) !== root
  ) {
    throw new Error("managed server state root is not private and owned");
  }
  const file = await open(statePath(), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const row = await file.stat();
    if (!row.isFile() || row.uid !== process.getuid?.() || (row.mode & 0o777) !== 0o600 || row.size > 4096) {
      throw new Error("managed server state is not private and bounded");
    }
    const bytes = Buffer.alloc(4097);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 4096) throw new Error("managed server state is too large");
    const value = stateFromJson(JSON.parse(bytes.subarray(0, offset).toString("utf8")));
    if (!value) throw new Error("managed server state is invalid");
    return value;
  } finally {
    await file.close();
  }
}
