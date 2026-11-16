import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relocatePiSessionInputs } from "./pi-inputs";

test("accepted UUIDs with uppercase hex keep their exact file identity when relocated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-pi-uppercase-"));
  const path = join(directory, "session.jsonl");
  const fileId = randomUUID().toUpperCase();
  const previous = `/run/pocketcoder/inputs/${randomUUID().toUpperCase()}/${fileId}`;
  await Bun.write(
    path,
    [
      JSON.stringify({ type: "session", version: 3 }),
      JSON.stringify({ type: "message", message: { role: "user", content: previous } }),
    ].join("\n") + "\n",
  );
  try {
    relocatePiSessionInputs(path, directory, [fileId]);
    const entries = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries[1].message.content).toBe(join(directory, fileId));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
