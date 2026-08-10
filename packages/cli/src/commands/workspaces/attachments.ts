import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { ApiRequest } from "./chat-session";

// CLI-side attachment uploads: files stream to the PocketCoder attachment API
// before the message referencing them is sent, so a failed upload never
// produces a half-attached turn.

const MEDIA_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

export function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function contentDisposition(name: string): string {
  const clean = name.replace(/[\r\n]/g, "");
  if (/^[ -~]*$/.test(clean)) {
    return `attachment; filename="${clean.replace(/(["\\])/g, "\\$1")}"`;
  }
  return `attachment; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

// Uploads local files and returns their attachment IDs in order. Throws on
// the first failure so callers can keep their queue and skip the message.
export async function uploadAttachments(
  api: ApiRequest,
  workspaceId: string,
  paths: string[],
  log: (line: string) => void,
): Promise<string[]> {
  const ids: string[] = [];
  for (const path of paths) {
    const name = basename(path);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new Error(`could not read attachment file: ${path}`);
    }
    log(`uploading ${name} (${bytes.byteLength} bytes)`);
    const id = randomUUID();
    const response = await api(`/v1/workspaces/${workspaceId}/attachments/${id}`, {
      method: "PUT",
      headers: {
        "content-type": mediaTypeOf(path),
        "content-disposition": contentDisposition(name),
        "content-length": String(bytes.byteLength),
      },
      body: bytes,
    });
    if (!response.ok) {
      throw new Error(`upload of ${name} failed (${response.status}): ${await response.text()}`);
    }
    ids.push(id);
  }
  return ids;
}

// Interactive chat commands for the attachment queue. Returns true when the
// line was a queue command and must not be sent as a message.
export function handleAttachmentCommand(
  line: string,
  queue: string[],
  print: (line: string) => void,
): boolean {
  const attach = line.match(/^\/attach\s+(.+)$/);
  if (attach) {
    const path = (attach[1] as string).trim();
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      // Fall through to the shared error below.
    }
    if (!isFile) {
      print(`no such file: ${path}`);
      return true;
    }
    queue.push(path);
    print(`queued ${basename(path)} (${queue.length} attachment${queue.length === 1 ? "" : "s"})`);
    return true;
  }
  if (line.trim() === "/attachments") {
    if (queue.length === 0) print("(no attachments queued)");
    for (const [index, path] of queue.entries()) print(`${index + 1}. ${path}`);
    return true;
  }
  const detach = line.match(/^\/detach\s+(.+)$/);
  if (detach) {
    const target = (detach[1] as string).trim();
    if (target === "all") {
      queue.length = 0;
      print("cleared attachment queue");
      return true;
    }
    const index = Number(target);
    if (Number.isInteger(index) && index >= 1 && index <= queue.length) {
      const [removed] = queue.splice(index - 1, 1);
      print(`removed ${removed}`);
    } else {
      print(`no queued attachment #${target}`);
    }
    return true;
  }
  return false;
}

export function fileFlags(value: unknown): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}
