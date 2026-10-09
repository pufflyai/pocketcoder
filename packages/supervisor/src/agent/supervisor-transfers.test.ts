import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { chmod, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecSpec, RestoreTransferSpec } from "@pstdio/pocketcoder-contracts";
import { downloadFixture } from "../checkpoints/filesystem-download-fixture";
import { SupervisorTransfers } from "./supervisor-transfers";

function execFor(mounts: RestoreTransferSpec["mounts"]): ExecSpec {
  return {
    agentapi_native: false,
    setup: [],
    harness: { command: ["true"], env: {} },
    env: {},
    services: {},
    terminal: null,
    timeouts: { start: "1s", maxAge: "1h", idle: "1h", disconnectGrace: "1s", terminateGrace: "1s" },
    security: { writable_memory_paths: [] },
    network: { mode: "unrestricted" },
    launch_mode: "restore",
    source: null,
    restore: null,
    persistence: { mounts, conversation_restore: "filesystem_only" },
    checkpoint_hook: null,
    outputs: {},
  };
}

test("authenticated HTTP restore verifies source identity and publishes fresh destination roots", async () => {
  const f = await downloadFixture();
  const bound = await f.boundArchive();
  const frames: Array<{ type: string; payload: unknown }> = [];
  const destination = { workspaceId: bound.binding.destination.workspaceId, connectionId: randomUUID(), epoch: 4 };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer destination-one-use");
      expect(request.headers.get("x-pocketcoder-workspace")).toBe(destination.workspaceId);
      expect(request.headers.get("x-pocketcoder-epoch")).toBe("4");
      return new Response(bound.stream);
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const grant: RestoreTransferSpec = {
    operation_id: bound.binding.destination.operationId,
    transfer_id: randomUUID(),
    checkpoint_id: f.header.checkpoint_id,
    credential: "destination-one-use",
    url: `${url}/v1/agent/checkpoints/restore`,
    expires_at: new Date(Date.now() + 4000).toISOString(),
    source: {
      checkpoint_id: f.header.checkpoint_id,
      workspace_id: f.header.workspace_id,
      template_digest: f.header.template_digest,
      archive_digest: bound.binding.source.archiveDigest,
    },
    mounts: f.mounts.map(({ parent, policy }) => ({ ...policy, target: parent })),
    max_archive_bytes: 1_000_000,
    max_index_bytes: 1_000_000,
    max_ledger_bytes: 1_000_000,
  };
  const transfers = new SupervisorTransfers(url, f.header.template_digest, {
    connection: () => destination,
    send(type, payload) {
      frames.push({ type, payload });
      return true;
    },
    quiesce: async () => {
      throw new Error("Restore cannot quiesce");
    },
  });
  try {
    await transfers.restore(grant, execFor(grant.mounts));
    expect(await readFile(`${f.work}/a`)).toEqual(f.bytes);
    expect((await readdir(f.work)).sort()).toEqual(["a", "deadlink", "z"]);
    expect(frames).toEqual([
      {
        type: "checkpoint_installed",
        payload: {
          operation_id: grant.operation_id,
          transfer_id: grant.transfer_id,
          checkpoint_id: grant.checkpoint_id,
          archive_digest: grant.source.archive_digest,
          phase: "installed",
        },
      },
    ]);
    expect(grant.credential).toBe("");
  } finally {
    await transfers.cancel();
    await server.stop(true);
    await chmod(`${f.work}/z`, 0o700).catch(() => {});
    await f.close();
  }
});

test("disconnect cancels a real HTTP download without installation", async () => {
  const f = await downloadFixture();
  const destination = { workspaceId: randomUUID(), connectionId: randomUUID(), epoch: 1 };
  let receiving!: () => void;
  const started = new Promise<void>((resolve) => {
    receiving = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(512));
    },
  });
  const server = Bun.serve({
    port: 0,
    fetch() {
      receiving();
      return new Response(stream);
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const phases: string[] = [];
  const grant: RestoreTransferSpec = {
    operation_id: randomUUID(),
    transfer_id: randomUUID(),
    checkpoint_id: f.header.checkpoint_id,
    credential: "destination",
    url: `${url}/v1/agent/checkpoints/restore`,
    expires_at: new Date(Date.now() + 4000).toISOString(),
    source: {
      checkpoint_id: f.header.checkpoint_id,
      workspace_id: f.header.workspace_id,
      template_digest: f.header.template_digest,
      archive_digest: f.binding.source.archiveDigest,
    },
    mounts: f.mounts.map(({ parent, policy }) => ({ ...policy, target: parent })),
    max_archive_bytes: 1_000_000,
    max_index_bytes: 1_000_000,
    max_ledger_bytes: 1_000_000,
  };
  const transfers = new SupervisorTransfers(url, f.header.template_digest, {
    connection: () => destination,
    send(_type, payload) {
      phases.push((payload as { phase: string }).phase);
      return true;
    },
    quiesce: async () => false,
  });
  const pending = transfers.restore(grant, execFor(grant.mounts));
  const refused = expect(pending).rejects.toThrow();
  try {
    await started;
    await transfers.cancel();
    await refused;
    expect(phases).toEqual(["failed"]);
    expect(await readdir(f.work)).toEqual([]);
    expect(grant.credential).toBe("");
  } finally {
    await server.stop(true);
    await chmod(`${f.work}/z`, 0o700).catch(() => {});
    await f.close();
  }
});

test("HTTP upload deadline drains prepared custody and clears one-use credentials", async () => {
  const f = await downloadFixture();
  const connection = { workspaceId: randomUUID(), connectionId: randomUUID(), epoch: 1 };
  let received!: () => void;
  const bodyReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.arrayBuffer();
      received();
      await gate;
      return new Response(null, { status: 204 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const phases: string[] = [];
  const transfers = new SupervisorTransfers(url, f.header.template_digest, {
    connection: () => connection,
    send(type, payload) {
      if (type === "checkpoint_upload_status") phases.push((payload as { phase: string }).phase);
      return true;
    },
    quiesce: async () => true,
  });
  const operationId = randomUUID();
  const grant = {
    operation_id: operationId,
    transfer_id: randomUUID(),
    checkpoint_id: f.header.checkpoint_id,
    credential: "one-use-expiring",
    url: `${url}/v1/agent/checkpoints/${operationId}/archive`,
    expires_at: new Date(Date.now() + 150).toISOString(),
  };
  try {
    await transfers.prepare(
      {
        operation_id: operationId,
        checkpoint_id: f.header.checkpoint_id,
        deadline_ms: 1000,
        mounts: f.mounts.map(({ parent, policy }) => ({ ...policy, target: parent })),
        max_archive_bytes: 1_000_000,
        max_index_bytes: 1_000_000,
        max_queue_bytes: 1_000_000,
      },
      execFor(f.mounts.map(({ parent, policy }) => ({ ...policy, target: parent }))),
    );
    const upload = transfers.upload(grant);
    await bodyReceived;
    await upload;
    expect(phases).toEqual(["failed"]);
    expect(grant.credential).toBe("");
    await transfers.cancel();
  } finally {
    release();
    await transfers.cancel();
    await server.stop(true);
    await f.close();
  }
});

test("transfer scratch cleanup refuses a foreign file rather than deleting it", async () => {
  const f = await downloadFixture();
  const connection = { workspaceId: randomUUID(), connectionId: randomUUID(), epoch: 1 };
  const before = new Set(readdirSync(tmpdir()));
  let scratch = "";
  const mounts = f.mounts.map(({ parent, policy }) => ({ ...policy, target: parent }));
  const transfers = new SupervisorTransfers("http://127.0.0.1:1", f.header.template_digest, {
    connection: () => connection,
    send(type) {
      if (type === "checkpoint_prepared") {
        const added = readdirSync(tmpdir()).filter(
          (name) => name.startsWith("pocketcoder-transfer-") && !before.has(name),
        );
        expect(added.length).toBe(1);
        scratch = join(tmpdir(), added[0] ?? "missing");
        writeFileSync(join(scratch, "foreign"), "keep unknown file");
      }
      return true;
    },
    quiesce: async () => true,
  });
  try {
    await transfers.prepare(
      {
        operation_id: randomUUID(),
        checkpoint_id: f.header.checkpoint_id,
        deadline_ms: 1000,
        mounts,
        max_archive_bytes: 1_000_000,
        max_index_bytes: 1_000_000,
        max_queue_bytes: 1_000_000,
      },
      execFor(mounts),
    );
    await expect(transfers.cancel()).rejects.toThrow();
    expect(await readFile(join(scratch, "foreign"), "utf8")).toBe("keep unknown file");
  } finally {
    await transfers.cancel().catch(() => {});
    if (scratch) await rm(scratch, { recursive: true });
    await f.close();
  }
});
