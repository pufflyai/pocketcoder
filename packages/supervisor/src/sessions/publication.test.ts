import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@pstdio/pocketcoder-contracts";
import { envelope } from "./fixture.test";
import { SessionProducer } from "./producer";

test("selected native files are immutable, bounded publications that replay after producer restart", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-native-publication-")));
  const file = join(directory, "report.csv");
  const bytes = Buffer.from("company,amount\nÅngström,42\n");
  const publicationId = randomUUID();
  const input = {
    ...envelope(),
    publicationPolicy: { roots: [directory], bytes: 1024, files: 1 },
  };
  const producer = new SessionProducer(join(directory, "journal"), async (run) => {
    const publish = run.publishFile;
    if (!publish) throw new Error("Missing publication capability");
    const selected = { path: file, publicationId, name: "report.csv", mediaType: "text/csv" };
    const receipt = publish(selected);
    expect(receipt).toMatchObject({ publicationId, name: "report.csv", state: "staged" });
    expect(publish(selected)).toEqual(receipt);
    await writeFile(file, "changed");
    expect(() => publish(selected)).toThrow("identity");
    expect(() => publish({ ...selected, publicationId: randomUUID() })).toThrow("limit");
  });
  try {
    await writeFile(file, bytes);
    await producer.accept(input);
    await producer.quiesce();
    const snapshot = await producer.lookup(input.acceptance.execution);
    if (snapshot.phase === "absent") throw new Error("Missing accepted request");
    expect(snapshot).toMatchObject({
      phase: "terminal",
      outcome: { status: "completed" },
      publication: {
        complete: true,
        objects: [
          {
            publicationId,
            name: "report.csv",
            digest: `sha256:${sha256Hex(bytes)}`,
            contentBase64: bytes.toString("base64"),
          },
        ],
      },
    });
    expect(JSON.stringify("messages" in snapshot && snapshot.messages)).not.toContain(bytes.toString("base64"));
    const restarted = new SessionProducer(join(directory, "journal"), async () => {
      throw new Error("Must not rerun");
    });
    expect(await restarted.accept(input)).toEqual(snapshot);
    expect(await restarted.lookup(input.acceptance.execution)).toEqual(snapshot);
    expect(await readFile(file, "utf8")).toBe("changed");
  } finally {
    await producer.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
