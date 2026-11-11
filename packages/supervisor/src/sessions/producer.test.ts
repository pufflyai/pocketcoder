import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf, ProducerObservationSchema } from "@pstdio/pocketcoder-contracts";
import { echoRunner } from "./echo";
import { envelope } from "./fixture.test";
import { SessionProducer } from "./producer";

test("native sessions keep canonical revisions through completion, replay and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-session-"));
  try {
    const producer = new SessionProducer(directory, echoRunner);
    const input = envelope();
    await producer.accept(input);
    let snapshot = await producer.lookup(input.acceptance.execution);
    while (snapshot.phase !== "terminal") {
      await Bun.sleep(5);
      snapshot = await producer.lookup(input.acceptance.execution);
    }
    const parsed = ProducerObservationSchema.parse(snapshot);
    expect(parsed.phase).toBe("terminal");
    if (parsed.phase === "absent") throw new Error("Missing execution");
    expect(parsed.messages?.find((message) => message.role === "assistant")?.parts).toEqual([
      { type: "text", text: `echo: ${input.acceptance.input.message}` },
    ]);
    expect(parsed.messages?.at(-1)?.identity?.fact).toEqual({ type: "turn_terminal", outcome: "completed" });
    expect(await producer.accept(input)).toEqual(snapshot);
    const restarted = new SessionProducer(directory, echoRunner);
    expect(await restarted.lookup(input.acceptance.execution)).toEqual(snapshot);
    expect(await restarted.ack(input.acceptance.execution, input.acceptance.fingerprint)).toEqual(snapshot);
    expect(await restarted.accept(input)).toEqual(snapshot);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["part", "turn"])("an oversized %s ends with a valid failed journal that can replay", async (limit) => {
  const directory = await mkdtemp(join(tmpdir(), "pc-session-limit-"));
  try {
    const producer = new SessionProducer(directory, async ({ emit }) => {
      if (limit === "part") emit("too-large", "assistant", [{ type: "text", text: "x".repeat(256 * 1024 + 1) }]);
      else
        for (let index = 0; index < 80; index++)
          emit(`tool:${index}`, "tool", [
            {
              type: "tool",
              call_id: String(index),
              name: "read",
              status: "completed",
              input: {},
              output: "x".repeat(200 * 1024),
            },
          ]);
    });
    const input = envelope();
    await producer.accept(input);
    await producer.quiesce();
    const result = ProducerObservationSchema.parse(await producer.lookup(input.acceptance.execution));
    expect(result).toMatchObject({ phase: "terminal", outcome: { status: "failed" } });
    if (result.phase === "absent") throw new Error("Missing journal");
    expect(result.messages?.find((message) => message.parts?.some((part) => part.type === "error"))).toBeDefined();
    expect(result.messages?.every(Boolean)).toBe(true);
    const restarted = new SessionProducer(directory, echoRunner);
    expect(await restarted.lookup(input.acceptance.execution)).toEqual(result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native sessions reject changed requests and fence an accept that arrives after cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-session-"));
  try {
    const producer = new SessionProducer(directory, echoRunner);
    const input = envelope();
    await producer.accept(input);
    const { fingerprint: _, ...facts } = input.acceptance;
    const changed = { ...facts, input: { message: "changed" } };
    await expect(
      producer.accept({ ...input, acceptance: { ...changed, fingerprint: digestOf(changed) } }),
    ).rejects.toThrow("fingerprint");
    const unseen = envelope();
    const canceled = await producer.cancel(unseen.acceptance.execution, unseen.acceptance.fingerprint);
    expect(canceled.phase).toBe("canceled");
    expect(await producer.accept(unseen)).toEqual(canceled);
    const restarted = new SessionProducer(directory, echoRunner);
    expect(await restarted.accept(unseen)).toEqual(canceled);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native cancellation closes unfinished tool parts before the terminal fact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-cancel-tool-"));
  try {
    const producer = new SessionProducer(directory, async ({ emit }) => {
      emit("tool:1", "tool", [
        { type: "tool", call_id: "1", name: "bash", status: "running", input: { command: "sleep 100" } },
      ]);
      return "canceled";
    });
    const input = envelope();
    await producer.accept(input);
    await producer.quiesce();
    const result = await producer.lookup(input.acceptance.execution);
    expect(result).toMatchObject({ phase: "canceled", outcome: { status: "canceled" } });
    expect("messages" in result && result.messages?.find((m) => m.role === "tool")?.parts?.[0]).toMatchObject({
      status: "canceled",
      ended_at: expect.any(String),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mandatory tool finalization cannot strand a journal at its output bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-finalization-bound-"));
  try {
    const producer = new SessionProducer(directory, async ({ emit, acceptance }) => {
      for (let i = 0; i < 30; i++)
        emit(`tool:${i}`, "tool", [
          {
            type: "tool",
            call_id: String(i),
            name: "read",
            status: "running",
            input: {},
            output: "x".repeat(200 * 1024),
          },
        ]);
      const part = {
        type: "tool" as const,
        call_id: "large",
        name: "read",
        status: "running" as const,
        input: {},
        output: "",
      };
      emit("large", "tool", [part]);
      const snapshot = await producer.lookup(acceptance.execution);
      if (snapshot.phase === "absent") throw new Error("Missing request");
      const fill = 4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(snapshot.messages)) - 10;
      emit("large", "tool", [{ ...part, output: "x".repeat(fill) }]);
    });
    const input = envelope();
    await producer.accept(input);
    await producer.quiesce();
    const result = await producer.lookup(input.acceptance.execution);
    expect(result.phase).toBe("terminal");
    expect("messages" in result && result.messages?.find((m) => m.role === "tool")?.parts?.[0]).toMatchObject({
      status: "failed",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the terminal journal is durable before its canonical fact is published", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-terminal-publish-"));
  const input = envelope();
  const observations: Promise<unknown>[] = [];
  try {
    const producer = new SessionProducer(directory, echoRunner, (message) => {
      if (message.identity?.fact?.type === "turn_terminal")
        observations.push(new SessionProducer(directory, echoRunner).lookup(input.acceptance.execution));
    });
    await producer.accept(input);
    await producer.quiesce();
    expect(await Promise.all(observations)).toEqual([
      expect.objectContaining({ phase: "terminal", outcome: expect.objectContaining({ status: "completed" }) }),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
