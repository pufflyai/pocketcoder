// PC-140: the whole managed chain on real Docker with the real Pi producer. Run with
// POCKETCODER_MANAGED_PI_CONFORMANCE=1; it builds the Pi starter image and needs the egress image.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PocketCoderError } from "@pstdio/pocketcoder-sdk";
import { ManagedRuntimeConsumer } from "../../../../examples/clients/managed-runtime/consumer";
import { PI_FIXTURE_CONTENT, PI_INTERRUPT_PROMPT } from "../../../../examples/harnesses/pi/fake-gateway";
import { waitFor } from "./e2e-test-support";
import { managedPiFixture } from "./managed-pi-fixture";
import { dockerCommand } from "./service-image-fixture";

const enabled = process.env.POCKETCODER_MANAGED_PI_CONFORMANCE === "1";
const allow = { canUse: () => true };
const token = () => `pocketcoder-doctor-${randomUUID()}`;
const ask = (value: string) => `Reply with exactly this diagnostic token: ${value}`;

async function setup() {
  const f = await managedPiFixture();
  const directory = await mkdtemp(join(tmpdir(), "pc-managed-pi-intents-"));
  const profile = await f.configure({ workspacesPerOwner: 4, sessionsPerWorkspace: 4 });
  const consumer = new ManagedRuntimeConsumer(f.client, allow);
  const wait = (sessionId: string, requestId: string) =>
    consumer.waitFor("user", sessionId, requestId, AbortSignal.timeout(240_000));
  // The gateway sees a model call once Pi is running this prompt inside the workspace.
  const reached = (prompt: string) =>
    waitFor(async () => f.gateway.calls.find((call) => call.prompt.includes(prompt)) ?? null, 120_000, "model call");
  return { f, consumer, profile, wait, reached, directory };
}

async function run(body: (s: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const s = await setup();
  try {
    await body(s);
  } catch (error) {
    console.error(
      s.f.logs
        .filter((line) => !line.includes("request.completed"))
        .slice(-60)
        .join("\n"),
    );
    for await (const workspace of s.f.admin.workspaces.all())
      console.error(JSON.stringify({ id: workspace.id, state: workspace.state, failure: workspace.failure }));
    throw error;
  } finally {
    await s.f.close();
    await rm(s.directory, { recursive: true, force: true });
  }
}

test.skipIf(!enabled)(
  "a consumer runs, observes, cancels and closes real Pi sessions placed on Docker",
  () =>
    run(async ({ f, consumer, profile, wait, reached }) => {
      const [a, b] = [await consumer.startSession(profile, "user"), await consumer.startSession(profile, "user")];
      const file = {
        inputId: randomUUID(),
        name: "brief.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("brief"),
      };
      const reference = await consumer.attach("user", a.sessionId, file);
      const written = await consumer.ask("user", a.sessionId, "Write notes.md containing: from Pi", {
        attachments: [reference.inputId],
      });
      const result = await wait(a.sessionId, written.requestId);
      expect(result.request).toMatchObject({ outcome: "completed" });
      expect(result.collection).toMatchObject({ completeness: "complete" });
      expect(result.exports.map((item) => item.name)).toEqual(["notes.md"]);
      const bytes = await f.client.files.content(a.sessionId, result.exports[0]?.exportId ?? "");
      expect(new TextDecoder().decode(bytes)).toBe("from Pi");
      const read = await consumer.ask("user", a.sessionId, "Read the fixture file.");
      const zero = await wait(a.sessionId, read.requestId);
      expect(zero.request.finalResponse).toBe(PI_FIXTURE_CONTENT);
      expect(zero.collection).toMatchObject({ state: "settled", completeness: "complete", objects: [] });
      // A lost reply is resent with the same body and answers with the original request.
      expect(
        (await consumer.ask("user", a.sessionId, "Read the fixture file.", { requestId: read.requestId })).turnId,
      ).toBe(read.turnId);

      // Scoped cancel: A's turn is held at the model while B runs a full turn.
      const held = await consumer.ask("user", a.sessionId, PI_INTERRUPT_PROMPT);
      await reached(PI_INTERRUPT_PROMPT);
      const sibling = await consumer.ask("user", b.sessionId, "Read the fixture file.");
      const receipt = await consumer.cancel("user", a.sessionId);
      expect(receipt.scope).toBe("session");
      expect((await wait(a.sessionId, held.requestId)).request.outcome).toBe("canceled");
      expect((await wait(b.sessionId, sibling.requestId)).request.outcome).toBe("completed");

      const history = await consumer.transcript("user", a.sessionId);
      expect(history.requests.map((request) => request.outcome)).toEqual(["completed", "completed", "canceled"]);
      // Every model call carried a bearer the issuer minted for a live workspace.
      expect(f.gateway.refused).toEqual([]);
      expect(new Set(f.gateway.calls.map((call) => call.workspaceId)).size).toBe(2);

      const close = await consumer.close("user", a.sessionId);
      expect(close.scope).toBe("session");
      await waitFor(
        async () => (await f.client.sessions.close(a.sessionId)).state === "completed",
        120_000,
        "session close",
      );
      const refused = await consumer.ask("user", a.sessionId, "after close").catch((error) => error);
      expect(refused).toBeInstanceOf(PocketCoderError);
      expect((refused as PocketCoderError).code).toBe("session.closed");
      expect((await consumer.transcript("user", a.sessionId)).requests.length).toBe(3);
    }),
  900_000,
);

test.skipIf(!enabled)(
  "a controller restart while Pi keeps running yields one completed canonical record",
  () =>
    run(async ({ f, consumer, profile, wait, reached }) => {
      const session = await consumer.startSession(profile, "user");
      const value = token();
      f.gateway.hold(value);
      const asked = await consumer.ask("user", session.sessionId, ask(value));
      await reached(value);
      await f.restart();
      f.gateway.release(value);
      const done = await wait(session.sessionId, asked.requestId);
      expect(done.request).toMatchObject({ outcome: "completed", finalResponse: value });
      const records = await consumer.transcript("user", session.sessionId);
      expect(records.requests.map((request) => [request.outcome, request.finalResponse])).toEqual([
        ["completed", value],
      ]);
    }),
  900_000,
);

test.skipIf(!enabled)(
  "lost compute is replaced under the same session without resending started work",
  () =>
    run(async ({ f, consumer, profile, wait, reached }) => {
      const session = await consumer.startSession(profile, "user");
      const started = token();
      f.gateway.hold(started);
      const asked = await consumer.ask("user", session.sessionId, ask(started));
      const first = await reached(started);
      for (const container of await f.containers()) await dockerCommand("rm", "-f", container);
      const lost = await wait(session.sessionId, asked.requestId);
      expect(lost.request.outcome).toBe("lost");
      f.gateway.release(started);
      const next = token();
      const later = await consumer.ask("user", session.sessionId, ask(next));
      const done = await wait(session.sessionId, later.requestId);
      expect(done.request).toMatchObject({ outcome: "completed", finalResponse: next });
      const replacement = f.gateway.calls.find((call) => call.prompt.includes(next));
      expect(replacement?.workspaceId).toBe(session.sessionId);
      // The started turn reached the model once, from the original workspace only.
      expect(f.gateway.calls.filter((call) => call.prompt.includes(started)).map((call) => call.workspaceId)).toEqual([
        first.workspaceId,
      ]);
      expect((await f.client.sessions.get(session.sessionId)).sessionId).toBe(session.sessionId);
    }),
  900_000,
);

// Runs a fetch inside the Pi workspace container, through its egress proxy unless told otherwise.
async function probe(container: string, url: string, viaProxy = true) {
  const script = `const r=await fetch(${JSON.stringify(url)},{${viaProxy ? 'proxy:"http://127.0.0.1:18080",' : ""}signal:AbortSignal.timeout(5000)}).then(r=>r.status,e=>"error:"+e.name);console.log(r)`;
  return dockerCommand("exec", container, "bun", "-e", script);
}

test.skipIf(!enabled)(
  "a managed Pi workspace reaches the model gateway route and nothing that bypasses it",
  () =>
    run(async ({ f, consumer, profile, wait }) => {
      const session = await consumer.startSession(profile, "user");
      const asked = await consumer.ask("user", session.sessionId, "Read the fixture file.");
      expect((await wait(session.sessionId, asked.requestId)).request.outcome).toBe("completed");
      const container = await dockerCommand("ps", "-q", "--filter", `ancestor=${f.images.imageId}`);
      expect(container).not.toBe("");
      const other = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("other") });
      try {
        const gateway = `http://host.docker.internal:${f.gateway.port}`;
        const elsewhere = `http://host.docker.internal:${other.port}/`;
        expect(await probe(container, `${gateway}/health`)).toBe("200");
        expect(await probe(container, "https://api.openai.com/v1/models")).not.toBe("200");
        expect(await probe(container, elsewhere)).toBe("403");
        expect(await probe(container, `${gateway}/redirect?to=${encodeURIComponent(elsewhere)}`)).toBe("403");
        expect(await probe(container, `${gateway}/health`, false)).toStartWith("error:");
        expect(await probe(container, "http://[2606:4700:4700::1111]/", false)).toStartWith("error:");
        // The model call itself used an issuer-minted bearer bound to this workspace.
        expect(f.gateway.refused).toEqual([]);
      } finally {
        other.stop(true);
      }
    }),
  900_000,
);

test.skipIf(!enabled)(
  "an owner's idle workspace makes room for another group and the old chat keeps its memory",
  () =>
    run(async ({ f, consumer, profile, wait }) => {
      await f.configure({ workspacesPerOwner: 1, sessionsPerWorkspace: 5 }, "shared");
      const first = await consumer.startSession(profile, "user", randomUUID(), "group-a");
      const remembered = token();
      const turn = await consumer.ask("user", first.sessionId, ask(remembered));
      expect((await wait(first.sessionId, turn.requestId)).request.finalResponse).toBe(remembered);
      const original = await f.containers();
      expect(original).toHaveLength(2);
      const second = await consumer.startSession(profile, "user", randomUUID(), "group-b");
      const next = await consumer.ask("user", second.sessionId, ask(token()));
      expect((await wait(second.sessionId, next.requestId)).request.outcome).toBe("completed");
      await waitFor(async () => (await f.containers()).length === 2, 120_000, "drained workspace cleanup");
      expect(await f.containers()).not.toEqual(original);
      const recalled = await consumer.ask("user", first.sessionId, "Repeat the earlier diagnostic token.");
      expect((await wait(first.sessionId, recalled.requestId)).request).toMatchObject({
        outcome: "completed",
        finalResponse: remembered,
      });
      await waitFor(async () => (await f.containers()).length === 2, 120_000, "drained workspace cleanup");
    }),
  900_000,
);
