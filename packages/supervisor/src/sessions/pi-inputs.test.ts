import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relocatePiSessionInputs } from "./pi-inputs";

test.each([
  { name: "non-ASCII prefix", prefix: "/東京", suffix: "" },
  { name: "non-ASCII suffix", prefix: "", suffix: "東京" },
  { name: "emoji prefix", prefix: "/🗂", suffix: "" },
  { name: "emoji suffix", prefix: "", suffix: "🗂" },
  { name: "combining-mark suffix", prefix: "", suffix: "\u0301" },
  { name: "ASCII prefix", prefix: "/other", suffix: "" },
  { name: "ASCII suffix", prefix: "", suffix: ".txt" },
])("$name preserves an unrelated path next to a relocatable input", async ({ prefix, suffix }) => {
  const directory = await mkdtemp(join(tmpdir(), "pc-pi-input-boundary-"));
  const path = join(directory, "session.jsonl");
  const fileId = randomUUID();
  const previous = `/run/pocketcoder/inputs/${randomUUID()}/${fileId}`;
  const unrelated = prefix + previous + suffix;
  await Bun.write(
    path,
    [
      JSON.stringify({ type: "session", version: 3 }),
      JSON.stringify({ type: "message", message: { role: "user", content: `${unrelated}\n${previous}` } }),
    ].join("\n") + "\n",
  );
  try {
    relocatePiSessionInputs(path, directory, [fileId]);
    const entries = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries[1].message.content).toBe(`${unrelated}\n${join(directory, fileId)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
