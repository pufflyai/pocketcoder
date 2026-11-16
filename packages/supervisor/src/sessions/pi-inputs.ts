import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const INPUT_PATH = new RegExp(`(?<![A-Za-z0-9._/-])/run/pocketcoder/inputs/${UUID}/(${UUID})(?![A-Za-z0-9._/-])`, "g");

// Only Pi's private user prompts name old projections. The controller's history
// and signed assistant/thinking blocks retain their original content.
export function relocatePiSessionInputs(path: string, directory: string | undefined, fileIds: string[]) {
  if (!directory || !fileIds.length || !existsSync(path)) return;
  const accepted = new Set(fileIds);
  const entries = readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (entries[0]?.type !== "session" || entries[0]?.version !== 3)
    throw new Error("Unsupported Pi session format for retained inputs");
  let changed = false;
  const relocate = (text: string) =>
    text.replace(INPUT_PATH, (original, fileId: string) => {
      if (!accepted.has(fileId)) return original;
      const current = join(directory, fileId);
      if (current !== original) changed = true;
      return current;
    });
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid Pi session entry");
    const message = entry.message;
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") message.content = relocate(message.content);
    else if (Array.isArray(message.content))
      message.content = message.content.map((part: { type?: string; text?: string }) =>
        part?.type === "text" && typeof part.text === "string" ? { ...part, text: relocate(part.text) } : part,
      );
  }
  if (!changed) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
