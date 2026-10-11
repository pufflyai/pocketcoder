import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountPurgeIntent,
  HEADER_PROTOCOL,
  HEADER_REGISTRATION,
  HEADER_WORKSPACE,
  PROTOCOL_VERSION,
} from "@pstdio/pocketcoder-contracts";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { wsPurgeChild } from "./ws-purge-race-inspector";

async function waitFor<T>(read: () => Promise<T | null>, label: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`${label} timed out`);
    await Bun.sleep(10);
  }
}

async function socketDeadline(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.skipIf(process.env.PC94_S3_TEST !== "1").each(["conversation", "registration"] as const)(
  "permanent authority fences an already admitted real socket %s result",
  async (boundary) => {
    const root = await mkdtemp(join(tmpdir(), "pc94-ws-purge-"));
    let storage: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let child: Awaited<ReturnType<typeof wsPurgeChild>> | undefined;
    let socket: WebSocket | undefined;
    let purge: Promise<Response> | undefined;
    const cleanupErrors: unknown[] = [];
    let failure: unknown;
    try {
      storage = await objectStorageFixture();
      const directory = join(root, "data");
      const accountId = randomUUID();
      const config = join(root, "config.json");
      await writeFile(config, JSON.stringify({ directory, accountId, storage: storage.config }), { mode: 0o600 });
      child = await wsPurgeChild(config);
      const issued = (await Bun.file(join(root, "issued.json")).json()) as {
        workspaceId: string;
        keyId: string;
        registration: string;
        digest: string;
      };
      const request = (path: string, body?: object) =>
        fetch(`http://localhost${path}`, {
          unix: join(directory, "admin.sock"),
          signal: AbortSignal.timeout(10_000),
          ...(body
            ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
            : {}),
        });
      const state = async () =>
        (await (await request("/fixture/state")).json()) as {
          conversationCount: number;
          hubPresent: boolean;
          revoked: boolean;
          state: string;
        };
      const connectionId = randomUUID();
      const frames: string[] = [];
      const closed = Promise.withResolvers<void>();
      socket = new WebSocket(`ws://127.0.0.1:${child.port}/v1/agent/connect`, {
        headers: {
          [HEADER_PROTOCOL]: String(PROTOCOL_VERSION),
          [HEADER_WORKSPACE]: issued.workspaceId,
          [HEADER_REGISTRATION]: issued.registration,
        },
      } as unknown as string[]);
      const connected = Promise.withResolvers<void>();
      socket.onopen = () => connected.resolve();
      socket.onerror = () => connected.reject(new Error("Real agent socket failed"));
      socket.onclose = () => closed.resolve();
      socket.onmessage = (event) => {
        frames.push(JSON.parse(String(event.data)).type);
      };
      await socketDeadline(connected.promise, "Agent socket open");
      const send = (type: string, seq: number, payload: object) =>
        socket?.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type,
            seq,
            workspace_id: issued.workspaceId,
            connection_id: connectionId,
            sent_at: new Date().toISOString(),
            payload,
          }),
        );
      const register = () =>
        send("registered", 0, {
          agent_version: "pc94-socket-fixture",
          template: { name: "fixture-echo", version: "1.0.0", digest: issued.digest },
          services: ["agent"],
          pid: process.pid,
        });
      const transcript = (seq: number) =>
        send("conversation_message", seq, {
          message_id: randomUUID(),
          role: "user",
          content: "synthetic queued purge fixture",
          occurred_at: new Date().toISOString(),
          metadata: {},
        });
      if (boundary === "conversation") {
        register();
        await waitFor(
          async () => (frames.includes("registered_ack") ? true : null),
          "Real registration acknowledgement",
        );
        transcript(1);
        await waitFor(
          async () => ((await state()).conversationCount === 1 ? true : null),
          "Accepted pre-purge transcript",
        );
      }
      const paused =
        boundary === "conversation"
          ? await child.arm(
              "ws-frame-handler.ts",
              "async function handleConversation(",
              "await deps.store.appendConversationMessage({",
            )
          : await child.arm(
              "ws-events.ts",
              "async function registerConnection(",
              "const connection = deps.hub.attach(",
            );
      if (boundary === "conversation") transcript(2);
      else register();
      await paused(5000);
      expect(await child.workspaceId()).toBe(issued.workspaceId);
      const intent: AccountPurgeIntent = {
        format: "pocketcoder-account-purge/v1",
        accountId,
        operationId: randomUUID(),
        createRequestDigest: createHash("sha256")
          .update(`pocketcoder-create-request/v1\0${randomUUID()}`)
          .digest("hex"),
        purgeRequestDigest: createHash("sha256").update(`pocketcoder-purge-request/v1\0${randomUUID()}`).digest("hex"),
        admittedAt: new Date().toISOString(),
      };
      for (const key of [
        `manager/purge/accounts/${accountId}/intent.json`,
        `manager/purge/requests/${intent.createRequestDigest}/intent.json`,
      ]) {
        const receipt = await storage.storage.putIfAbsent(key, Buffer.from(JSON.stringify(intent)));
        expect(await (await storage.storage.get(key, receipt.versionId)).json()).toEqual(intent);
      }
      // This is external authority arrival during an admitted frame, not cleanup while the child is paused.
      purge = request("/v1/account/purge", { operation_id: intent.operationId });
      await child.resume();
      expect((await purge).status).toBe(503);
      const result = await state();
      expect(result.revoked).toBe(true);
      expect(result.hubPresent).toBe(false);
      expect(await (await request("/v1/account/purge")).json()).toMatchObject({
        operation_id: intent.operationId,
        operation_state: "pending",
      });
      await socketDeadline(closed.promise, "Original agent socket close");
      console.log(
        JSON.stringify({
          boundary,
          accountId,
          workspaceId: issued.workspaceId,
          keyId: issued.keyId,
          revoked: result.revoked,
          conversationCount: result.conversationCount,
          acknowledgementPresent: frames.includes("registered_ack"),
        }),
      );
      if (boundary === "conversation") expect(result.conversationCount).toBe(1);
      else expect(frames).not.toContain("registered_ack");
    } catch (error) {
      failure = error;
    } finally {
      socket?.close();
      for (const result of await Promise.allSettled([child?.close(), purge]))
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      for (const result of await Promise.allSettled([storage?.close(), rm(root, { recursive: true, force: true })]))
        if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        "Socket purge fixture cleanup failed",
      );
    if (failure) throw failure;
  },
  45_000,
);
