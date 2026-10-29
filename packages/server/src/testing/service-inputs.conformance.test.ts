import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  digestOf,
  ExecutionRecordSchema,
  ExecutionRuntimeSchema,
  WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { loadConfig } from "../config/config";
import { startPocketCoderServer } from "../lifecycle/lifecycle";
import { waitFor } from "./e2e-test-support";
import { serviceImageFixture, serviceProbeImage } from "./service-image-fixture.test";

const available =
  Bun.spawnSync(["docker", "image", "inspect", serviceProbeImage], { stdout: "ignore", stderr: "ignore" }).exitCode ===
  0;
function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  server.stop(true);
  return port;
}

test.skipIf(!available)(
  "public service admission delivers verified read-only inputs through the durable execution owner",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pc-service-public-")));
    const image = await serviceImageFixture(join(root, "image"));
    const port = freePort();
    const agentPort = freePort();
    const logs: string[] = [];
    const directory = join(root, "data");
    const config = loadConfig({
      POCKETCODER_WORKLOAD_LIMITS: JSON.stringify(image.manifest.spec.limits),
      POCKETCODER_DIR: directory,
      POCKETCODER_HTTP: `127.0.0.1:${port}`,
      POCKETCODER_AGENT_HTTP: `0.0.0.0:${agentPort}`,
      POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${agentPort}`,
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
        principal: { bytes: 16777216, files: 32 },
        instance: { bytes: 33554432, files: 64 },
        headroom: { bytes: 1, files: 1 },
      }),
    });
    const server = await startPocketCoderServer(config, { log: (line) => logs.push(line) });
    let workspaceId: string | undefined;
    let token = "";
    let identityForDebug = "";
    let incarnationForDebug = "";
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.ok, await response.clone().text()).toBe(true);
      return response.status === 204 ? null : response.json();
    };
    try {
      const owner = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          resolve(import.meta.dir, "../../../cli/src/index.ts"),
          "superuser",
          "create",
          "--dir",
          directory,
          "--automation",
          "--expires",
          new Date(Date.now() + 3600000).toISOString(),
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
      const workspace = await request("/v1/workspaces", "POST", {
        external_id: randomUUID(),
        template: { name: image.manifest.metadata.name },
      });
      workspaceId = WorkspaceResourceSchema.parse(workspace).id;
      await waitFor(
        async () => {
          const current = WorkspaceResourceSchema.parse(await request(`/v1/workspaces/${workspaceId}`));
          if (current.state === "failed") throw new Error(logs.join("\n"));
          return current.state === "ready";
        },
        30000,
        "public service readiness",
      );
      const runtime = ExecutionRuntimeSchema.parse(await request(`/v1/workspaces/${workspaceId}/execution-runtime`));
      expect(runtime.template.format).toBe("pocketcoder.dev/v1");
      expect(runtime.producer.capabilities).toContain("immutable-inputs");
      for (const prefix of ["services/agent", "agent"]) {
        const refused = await fetch(
          `http://127.0.0.1:${port}/v1/workspaces/${workspaceId}/${prefix}/executions/accept`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: "{}",
          },
        );
        expect(refused.status).toBe(422);
      }
      const bytes = "readonly-input";
      const fileId = randomUUID();
      const upload = await fetch(`http://127.0.0.1:${port}/v1/workspaces/${workspaceId}/attachments/${fileId}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "text/plain",
          "content-length": String(bytes.length),
          "content-disposition": 'attachment; filename="proof.txt"',
          "x-content-sha256": new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        },
        body: bytes,
      });
      expect(upload.status, await upload.clone().text()).toBe(201);
      const reference = await upload.json();
      const objects = { workspaceId: runtime.workspaceId, incarnationId: runtime.incarnationId, objects: [reference] };
      const identity = {
        schema: "pocketcoder.conversation/v2",
        authority: "external",
        conversation_id: randomUUID(),
        request_id: randomUUID(),
        turn_id: randomUUID(),
        request_fingerprint: "a".repeat(64),
      };
      await request(`/v1/workspaces/${workspaceId}/conversation/requests`, "POST", identity);
      const facts = {
        execution: {
          workspaceId: runtime.workspaceId,
          incarnationId: runtime.incarnationId,
          owner: "conversation-request",
          requestId: identity.request_id,
        },
        callerPrincipalId: runtime.callerPrincipalId,
        templateDigest: runtime.template.digest,
        adapterDigest: runtime.producer.adapters.main?.digest,
        operation: "message",
        input: {},
        inputs: { ...objects, digest: digestOf(objects) },
        bindingSetDigest: digestOf([]),
      };
      identityForDebug = identity.request_id;
      incarnationForDebug = runtime.incarnationId;
      const body = { acceptance: { ...facts, fingerprint: digestOf(facts) }, conversationIdentity: identity };
      await request(`/v1/workspaces/${workspaceId}/executions`, "POST", body);
      const path = `/v1/workspaces/${workspaceId}/executions/${identity.request_id}?incarnationId=${encodeURIComponent(runtime.incarnationId)}&owner=conversation-request`;
      const result = await waitFor(
        async () => {
          const current = ExecutionRecordSchema.parse(await request(path));
          return current.finalizedAt ? current : null;
        },
        15000,
        "public immutable service execution",
      );
      expect(result.phase).toBe("terminal");
      expect(result.outcome).toEqual({ content: bytes, immutable: true });
      const replay = ExecutionRecordSchema.parse(
        await request(`/v1/workspaces/${workspaceId}/executions`, "POST", body),
      );
      expect(replay.acceptance.fingerprint).toBe(body.acceptance.fingerprint);
      expect(replay.outcome).toEqual(result.outcome);
      const nextIdentity = { ...identity, request_id: randomUUID(), turn_id: randomUUID() };
      await request(`/v1/workspaces/${workspaceId}/conversation/requests`, "POST", nextIdentity);
      const nextFacts = { ...facts, execution: { ...facts.execution, requestId: nextIdentity.request_id } };
      await request(`/v1/workspaces/${workspaceId}/executions`, "POST", {
        acceptance: { ...nextFacts, fingerprint: digestOf(nextFacts) },
        conversationIdentity: nextIdentity,
      });
    } catch (error) {
      console.error(logs.slice(-30).join("\n"));
      if (workspaceId)
        console.error(
          await request(
            `/v1/workspaces/${workspaceId}/executions/${identityForDebug}?incarnationId=${incarnationForDebug}&owner=conversation-request`,
          ).catch(() => null),
        );
      throw error;
    } finally {
      if (workspaceId && token) await request(`/v1/workspaces/${workspaceId}/cancel`, "POST", {});
      await server.stop();
      await image.remove();
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
