import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  type AgentFrame,
  type FiniteProcessFact,
  PROTOCOL_VERSION,
  parseTemplateManifest,
  parseWorkloadTemplate,
  snapshotOf,
  workloadSnapshotOf,
} from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory, executionFixture } from "@pstdio/pocketcoder-db/testing";
import { fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import type { WSContext } from "hono/ws";
import { createTestServer, SERVER_TEST_PEPPER } from "../testing/test-server.test";
import { seedWaitingWorkspace } from "./waiting-workspace-fixture.test";
import { handleConnectedFrame } from "./ws-frame-handler";

const createStore = createTestStoreFactory();

test("waiting readiness is separate from process completion and terminal facts are acknowledged after persistence", async () => {
  const f = await executionFixture(
    (source) => {
      source.spec.network = { mode: "unrestricted" };
    },
    { ready: false },
  );
  const server = await createTestServer(f.store, { globalActiveWorkspaces: 0 });
  const id = f.id;
  const sent: { type: string; payload: unknown }[] = [];
  const socket = {
    send(raw: string) {
      sent.push(JSON.parse(raw));
    },
    close() {},
  } as unknown as WSContext;
  const connection = server.hub.attach(id, randomUUID(), 1, socket, PROTOCOL_VERSION);
  const frame = (type: AgentFrame["type"], payload: unknown) =>
    ({
      v: PROTOCOL_VERSION,
      workspace_id: id,
      connection_id: connection.connectionId,
      seq: 1,
      sent_at: new Date().toISOString(),
      type,
      payload,
    }) as AgentFrame;
  const receive = (type: AgentFrame["type"], payload: unknown) =>
    handleConnectedFrame({ ...server, pepper: SERVER_TEST_PEPPER }, connection, socket, frame(type, payload), () => {});
  await receive("service_health", { service: "agent", health: "healthy" });
  expect((await server.store.getWorkspace(id))?.state).toBe("connected");
  await receive("runtime_ready", { incarnationId: "wrong" });
  expect((await server.store.getWorkspace(id))?.state).toBe("connected");
  await receive("runtime_ready", { incarnationId: f.runtime.incarnationId });
  expect((await server.store.getWorkspace(id))?.state).toBe("ready");
  const accepted = f.acceptance();
  await f.store.executions.accept(accepted, new Date());
  await f.store.executions.claim(accepted.execution, new Date());
  const fact: FiniteProcessFact = {
    execution: { ...accepted.execution, owner: "process" },
    fingerprint: accepted.fingerprint,
    phase: "exited",
    processGroupId: 123,
    claimedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    exitCode: 7,
    signal: null,
  };
  await receive("finite_process", {
    ...fact,
    phase: "claimed",
    startedAt: null,
    endedAt: null,
    processGroupId: null,
    exitCode: null,
  });
  expect(sent.filter((frame) => frame.type === "process_ack")).toEqual([]);
  await receive("finite_process", fact);
  expect((await server.store.getWorkspace(id))?.finiteProcess).toEqual(fact);
  expect((await server.store.getWorkspace(id))?.state).toBe("ready");
  expect(sent.at(-1)).toMatchObject({ type: "process_ack", payload: { execution: fact.execution } });
  await receive("process_state", { phase: "exited", exit_code: 0 });
  expect((await server.store.getWorkspace(id))?.state).toBe("ready");
  await receive("finite_process", { ...fact, exitCode: 0 });
  expect((await server.store.getWorkspace(id))?.finiteProcess).toEqual(fact);
  server.hub.close(id);
  await f.dispose();
});

test("canonical network readiness stays required when the lifecycle policy is unrestricted", async () => {
  const store = await createStore();
  const server = await createTestServer(store, { globalActiveWorkspaces: 0 });
  const source = await Bun.file(resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json")).json();
  const snapshot = workloadSnapshotOf(parseWorkloadTemplate(source));
  const { workspace } = await seedWaitingWorkspace(store, snapshot);
  const ref = { kind: "fake", id: "restricted-runtime" };
  await store.transition(workspace.id, {
    from: ["queued"],
    to: "provisioning",
    at: new Date(),
    patch: { providerRef: ref, providerKind: "fake" },
  });
  await store.bindWorkspaceRuntime(
    workspace.id,
    { incarnationId: ref.id, containerIdentity: ref.id, profile: "finite-process", producer: null, template: snapshot },
    ref,
  );
  await store.transition(workspace.id, {
    from: ["provisioning"],
    to: "connected",
    at: new Date(),
    patch: { connectionEpoch: 1 },
  });
  const socket = { send() {}, close() {} } as unknown as WSContext;
  const connection = server.hub.attach(workspace.id, randomUUID(), 1, socket, PROTOCOL_VERSION);
  const receive = (type: AgentFrame["type"], payload: unknown) =>
    handleConnectedFrame(
      { ...server, pepper: SERVER_TEST_PEPPER },
      connection,
      socket,
      {
        v: PROTOCOL_VERSION,
        workspace_id: workspace.id,
        connection_id: connection.connectionId,
        seq: 1,
        sent_at: new Date().toISOString(),
        type,
        payload,
      } as AgentFrame,
      () => {},
    );
  await receive("runtime_ready", { incarnationId: ref.id });
  expect((await store.getWorkspace(workspace.id))?.state).toBe("connected");
  await receive("network_state", { state: "ready" });
  expect((await store.getWorkspace(workspace.id))?.state).toBe("ready");
  server.hub.close(workspace.id);
});

test("alpha network preflight cannot complete readiness before setup and harness startup", async () => {
  const store = await createStore();
  const server = await createTestServer(store, { globalActiveWorkspaces: 0 });
  const manifest = fixtureTemplateEcho({ version: "1.0.1" }).manifest;
  manifest.spec.services = {};
  manifest.spec.network = { mode: "restricted", allow: [] };
  manifest.spec.setup = [{ name: "prepare", command: ["/bin/true"], timeoutSeconds: 3, env: {}, runOn: ["create"] }];
  const parsed = parseTemplateManifest(manifest);
  const { row: template } = await store.upsertTemplate({
    name: manifest.metadata.name,
    version: manifest.spec.version,
    digest: parsed.digest,
    description: null,
    spec: parsed.manifest.spec,
  });
  const principal = await store.createPrincipal(randomUUID(), ["admin"], ["*"]);
  const id = randomUUID();
  await store.insertWorkspace({
    id,
    principalId: principal.id,
    externalId: id,
    idempotencyKey: id,
    requestDigest: id,
    templateId: template.id,
    templateSnapshot: snapshotOf(parsed),
    launchInput: null,
    metadata: {},
    createdAt: new Date(),
    deadlineAt: new Date(Date.now() + 600000),
  });
  await store.transition(id, { from: ["queued"], to: "provisioning", at: new Date() });
  await store.transition(id, {
    from: ["provisioning"],
    to: "connected",
    at: new Date(),
    patch: { connectionEpoch: 1 },
  });
  const socket = { send() {}, close() {} } as unknown as WSContext;
  const connection = server.hub.attach(id, randomUUID(), 1, socket, PROTOCOL_VERSION);
  const receive = (type: AgentFrame["type"], payload: unknown) =>
    handleConnectedFrame(
      { ...server, pepper: SERVER_TEST_PEPPER },
      connection,
      socket,
      {
        v: PROTOCOL_VERSION,
        workspace_id: id,
        connection_id: connection.connectionId,
        seq: 1,
        sent_at: new Date().toISOString(),
        type,
        payload,
      } as AgentFrame,
      () => {},
    );
  await receive("network_state", { state: "ready" });
  expect(await store.getWorkspace(id)).toMatchObject({ state: "connected", readyAt: null, networkState: "ready" });
  expect(connection.harnessRunning).toBe(false);
  await receive("process_state", { phase: "setup" });
  expect(await store.getWorkspace(id)).toMatchObject({ state: "connected", readyAt: null });
  await receive("process_state", { phase: "running" });
  expect((await store.getWorkspace(id))?.state).toBe("ready");
  expect(connection.harnessRunning).toBe(true);
  server.hub.close(id);
});
