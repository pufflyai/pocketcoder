import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { managed } from "@pstdio/pocketcoder-sdk";

export interface TurnIntent {
  userId: string;
  sessionId: string;
  body: managed.RequestInput;
}

// The consumer's own durable record of what it asked for. Each request body is written here
// before it is sent, so a crash or lost reply is retried with the identical body and the same
// request ID. This is application state, not runtime state: it never tracks dispatch or outcomes.
export class IntentFile {
  private constructor(
    private readonly path: string,
    private readonly intents: Map<string, TurnIntent>,
  ) {}

  static async open(path: string) {
    const stored = existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as TurnIntent[]) : [];
    return new IntentFile(path, new Map(stored.map((intent) => [intent.body.requestId, intent])));
  }

  get(requestId: string) {
    return this.intents.get(requestId);
  }

  pending(sessionId: string) {
    return [...this.intents.values()].filter((intent) => intent.sessionId === sessionId);
  }

  async save(intent: TurnIntent) {
    this.intents.set(intent.body.requestId, intent);
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.intents.values()], null, 2));
    await rename(temporary, this.path);
  }
}
