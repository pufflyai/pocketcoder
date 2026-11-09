import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntentFile } from "./intents";

test("concurrent saves all reach the intent file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-intents-"));
  try {
    const path = join(directory, "intents.json");
    const file = await IntentFile.open(path);
    const sessionId = randomUUID();
    const bodies = Array.from({ length: 20 }, () => ({
      requestId: randomUUID(),
      message: "hello",
      attachments: [],
      dispatchDeadline: new Date(Date.now() + 60_000).toISOString(),
    }));
    await Promise.all(bodies.map((body) => file.save({ userId: "user", sessionId, body })));
    expect((await IntentFile.open(path)).pending(sessionId)).toHaveLength(20);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
