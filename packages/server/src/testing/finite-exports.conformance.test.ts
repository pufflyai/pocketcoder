import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  digestOf,
  ExecutionRecordSchema,
  ExecutionRuntimeSchema,
  FiniteProcessFactSchema,
  LifetimeReceiptSchema,
  WorkloadExportReferenceSchema,
  WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { loadConfig } from "../config/config";
import { startPocketCoderServer } from "../lifecycle/lifecycle";
import { finiteImageFixture } from "./finite-image-fixture";
import { dockerCommand, serviceProbeImage } from "./service-image-fixture";

function port() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const value = Number(server.port);
  server.stop(true);
  return value;
}

// Disabled at the maintainer's request until this capacity sweep is split into focused tests.
test.skipIf(true)(
  "public Docker jobs retain exact uploaded bytes after automatic compute removal at 1/5/20 concurrency",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pc131-public-")));
    const image = await finiteImageFixture(join(root, "image"));
    const httpPort = port();
    const agentPort = port();
    const config = loadConfig({
      POCKETCODER_DIR: join(root, "data"),
      POCKETCODER_HTTP: `127.0.0.1:${httpPort}`,
      POCKETCODER_AGENT_HTTP: `0.0.0.0:${agentPort}`,
      POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${agentPort}`,
      POCKETCODER_WORKLOAD_LIMITS: JSON.stringify(image.manifest.spec.limits),
      POCKETCODER_STORAGE_BACKEND: "filesystem",
      POCKETCODER_WORKSPACE_DATA_DIR: join(root, "work"),
      POCKETCODER_CHECKPOINT_DIR: join(root, "checkpoints"),
      POCKETCODER_INPUT_DIR: join(root, "launch"),
      POCKETCODER_INPUT_STORAGE: JSON.stringify({
        root: join(root, "canonical"),
        projection: {
          root: join(root, "projection"),
          probeImage: serviceProbeImage,
          capacity: { bytes: 16777216, files: 256 },
        },
        limits: {
          fileBytes: 1048576,
          stagedBytes: 8388608,
          files: 16,
          transfers: 2,
          transferMs: 30000,
          retentionMs: 600000,
        },
        principal: { bytes: 16777216, files: 1024 },
        instance: { bytes: 536870912, files: 8192 },
        headroom: { bytes: 1, files: 1 },
      }),
    });
    const logs: string[] = [];
    const server = await startPocketCoderServer(config, { log: (line) => logs.push(line) });
    let token = "";
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${httpPort}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.ok, response.ok ? undefined : await response.text()).toBe(true);
      return response.json();
    };
    const ids: string[] = [];
    try {
      const owner = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          resolve(import.meta.dir, "../../../cli/src/index.ts"),
          "superuser",
          "create",
          "--dir",
          join(root, "data"),
          "--automation",
          "--expires",
          new Date(Date.now() + 600000).toISOString(),
          "--json",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(owner.stdout).text(),
        new Response(owner.stderr).text(),
        owner.exited,
      ]);
      expect(code, err).toBe(0);
      token = JSON.parse(out).token;
      await request("/v1/templates", "POST", { manifest: image.manifest });
      const client = new PocketCoderClient({ baseUrl: `http://127.0.0.1:${httpPort}`, apiKey: token });
      const prepare = async () => {
        const workspace = WorkspaceResourceSchema.parse(
          await request("/v1/workspaces", "POST", {
            external_id: randomUUID(),
            template: { name: image.manifest.metadata.name },
          }),
        );
        const id = workspace.id as string;
        ids.push(id);
        let admitted = workspace;
        while (admitted.state === "queued") {
          admitted = (await client.workspaces.change(id, admitted.change_cursor, 30)).workspace;
        }
        await client.workspaces.waitForReady(admitted, 30000, { signal: AbortSignal.timeout(30000) });
        return workspace;
      };
      const run = async (workspace: ReturnType<typeof WorkspaceResourceSchema.parse>) => {
        const id = workspace.id;
        const extension = {
          extensionId: randomUUID(),
          expectedRevision: workspace.lifetime?.revision,
          deadlineAt: new Date(Date.parse(workspace.deadline_at) + 1000).toISOString(),
        };
        const lifetime = LifetimeReceiptSchema.parse(await request(`/v1/workspaces/${id}/lifetime`, "POST", extension));
        expect(lifetime.revision).toBe(2);
        expect(await request(`/v1/workspaces/${id}/lifetime`, "POST", extension)).toEqual(lifetime);
        const runtime = ExecutionRuntimeSchema.parse(await request(`/v1/workspaces/${id}/execution-runtime`));
        if (ids[0] === id) console.log(JSON.stringify({ ticket: "PC-131", installedProducer: runtime.producer }));
        const upload = await fetch(`http://127.0.0.1:${httpPort}/v1/workspaces/${id}/attachments/${randomUUID()}`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="input.txt"',
            "x-content-sha256": new Bun.CryptoHasher("sha256").update("input").digest("hex"),
          },
          body: "input",
        });
        expect(upload.status, upload.status === 201 ? undefined : await upload.text()).toBe(201);
        const inputs = { workspaceId: id, incarnationId: runtime.incarnationId, objects: [await upload.json()] };
        const execution = {
          workspaceId: id,
          incarnationId: runtime.incarnationId,
          owner: "process",
          requestId: randomUUID(),
        };
        const facts = {
          execution,
          callerPrincipalId: runtime.callerPrincipalId,
          templateDigest: runtime.template.digest,
          adapterDigest: runtime.producer.adapters.main?.digest,
          operation: "run",
          input: {},
          inputs: { ...inputs, digest: digestOf(inputs) },
          bindingSetDigest: digestOf([]),
        };
        await request(`/v1/workspaces/${id}/executions`, "POST", {
          acceptance: { ...facts, fingerprint: digestOf(facts) },
        });
        await waitForSuccess(client, id);
        const record = ExecutionRecordSchema.parse(
          await request(
            `/v1/workspaces/${id}/executions/${execution.requestId}?owner=process&incarnationId=${encodeURIComponent(runtime.incarnationId)}`,
          ),
        );
        expect(FiniteProcessFactSchema.parse(record.outcome).exitCode).toBe(0);
        await request(`/v1/workspaces/${id}/executions/${execution.requestId}/exports`);
        const manifest = WorkloadExportReferenceSchema.parse(record.collection);
        expect(manifest.cleanupState).toBe("complete");
        expect(WorkspaceResourceSchema.parse(await request(`/v1/workspaces/${id}`)).deadline_at).toBe(
          extension.deadlineAt,
        );
        expect(manifest.completeness, JSON.stringify(manifest)).toBe("complete");
        expect(manifest.objects).toHaveLength(1);
        const bytes = await fetch(
          `http://127.0.0.1:${httpPort}/v1/workspaces/${id}/exports/${manifest.objects[0]?.objectId}/content`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        expect(await bytes.text()).toBe("input-result");
      };
      for (const concurrency of [1, 5, 20]) {
        const started = performance.now();
        const workspaces = await Promise.all(Array.from({ length: concurrency }, prepare));
        await Promise.all(workspaces.map(run));
        const remaining = (await dockerCommand("ps", "-a", "--format", '{{.Label "pocketcoder.workspace"}}')).split(
          "\n",
        );
        for (const workspace of workspaces) expect(remaining).not.toContain(workspace.id);
        console.log(
          JSON.stringify({ ticket: "PC-131", image: image.image, concurrency, elapsedMs: performance.now() - started }),
        );
      }
    } catch (error) {
      console.error(
        logs
          .filter((line) => !line.includes('"event":"request.completed"'))
          .slice(-40)
          .join("\n"),
      );
      for (const id of ids) console.error(JSON.stringify(await request(`/v1/workspaces/${id}`).catch(() => null)));
      throw error;
    } finally {
      for (const id of ids) await request(`/v1/workspaces/${id}/cancel`, "POST", {}).catch(() => {});
      await server.stop();
      await image.remove();
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);

async function waitForSuccess(client: PocketCoderClient, id: string) {
  const deadline = Date.now() + 30000;
  const signal = AbortSignal.timeout(30000);
  let row = await client.workspaces.get(id, { signal });
  while (row.state !== "succeeded") {
    expect(["failed", "canceled", "expired"]).not.toContain(row.state);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Timed out waiting for finite automatic teardown");
    row = (await client.workspaces.change(id, row.change_cursor, Math.max(1, Math.ceil(remaining / 1000)), { signal }))
      .workspace;
  }
}
