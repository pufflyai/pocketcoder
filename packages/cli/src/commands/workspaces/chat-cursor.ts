import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatFlags } from "./chat-session";

export interface ChatCursor {
  value: string;
  file: string;
  all: Record<string, string | number>;
}

export interface MessageBaseline {
  maxId: number;
  length: number;
}

function cursorFile(): string {
  const root =
    process.env.POCKETCODER_STATE_DIR ?? join(homedir(), ".local", "state", "pocketcoder");
  return join(root, "message-cursors.json");
}

function readCursors(path: string): Record<string, string | number> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, string | number>;
  } catch {
    return {};
  }
}

function writeCursors(path: string, cursors: Record<string, string | number>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(cursors, null, 2)}\n`, { mode: 0o600 });
}

export function messageCursor(messages: unknown[], after: string): string | number {
  const last = messages.at(-1) as { id?: unknown } | undefined;
  if (last && (typeof last.id === "number" || typeof last.id === "string")) return last.id;
  return Number(after) + messages.length;
}

export function chatCursor(id: string, flags: ChatFlags): ChatCursor {
  const file = cursorFile();
  const all = readCursors(file);
  return {
    value: typeof flags.after === "string" ? flags.after : String(all[id] ?? 0),
    file,
    all,
  };
}

function numericMessageId(message: unknown): number | null {
  if (typeof message !== "object" || message === null) return null;
  const id = (message as Record<string, unknown>).id;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  if (typeof id === "string" && id.trim() !== "") {
    const parsed = Number(id);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function messageBaseline(messages: unknown[]): MessageBaseline {
  return {
    maxId: messages.reduce<number>((maximum, message) => {
      const id = numericMessageId(message);
      return id === null ? maximum : Math.max(maximum, id);
    }, -1),
    length: messages.length,
  };
}

export function messagesAfter(messages: unknown[], baseline: MessageBaseline): unknown[] {
  const identified = messages.filter((message) => numericMessageId(message) !== null);
  if (identified.length > 0) {
    return identified.filter((message) => (numericMessageId(message) ?? -1) > baseline.maxId);
  }
  return messages.slice(baseline.length);
}

export function advanceCursor(id: string, cursor: ChatCursor, messages: unknown[]): void {
  if (messages.length === 0) return;
  const baseline = messageBaseline(messages);
  setCursor(
    id,
    cursor,
    baseline.maxId >= 0
      ? String(Math.max(Number(cursor.value) || 0, baseline.maxId))
      : String(Number(cursor.value) + messages.length),
  );
}

export function setCursor(id: string, cursor: ChatCursor, value: string | number): void {
  cursor.value = String(value);
  cursor.all[id] = value;
  writeCursors(cursor.file, cursor.all);
}
