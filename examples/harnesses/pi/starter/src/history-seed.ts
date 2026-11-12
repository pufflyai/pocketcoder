import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
export type PriorMessage = { role: "user" | "assistant"; content: string };

// Pi v3's append-only session format. Only a new file is seeded, so retries retain native memory.
export function seedPiSession(path: string, messages: PriorMessage[] | undefined) {
  if (!messages?.length || existsSync(path)) return;
  const timestamp = new Date().toISOString();
  const entries: object[] = [{ type: "session", version: 3, id: randomUUID(), timestamp, cwd: process.cwd() }];
  let parentId: string | null = null;
  for (const prior of messages) {
    const id = randomUUID().slice(0, 8);
    const message =
      prior.role === "user"
        ? { role: "user", content: prior.content, timestamp: Date.now() }
        : {
            role: "assistant",
            content: [{ type: "text", text: prior.content }],
            api: "openai-responses",
            provider: "pocketcoder",
            model: "history",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          };
    entries.push({ type: "message", id, parentId, timestamp, message });
    parentId = id;
  }
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
}
