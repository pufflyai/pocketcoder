import { randomUUID } from "node:crypto";
import {
  digestOf,
  parseWorkloadTemplate,
  snapshotOf,
  type WorkloadAcceptance,
  workloadSnapshotOf,
} from "@pstdio/pocketcoder-contracts";
import { createPGliteFixture } from "../../test-fixtures";

export async function executionFixture(
  configure?: (source: import("@pstdio/pocketcoder-contracts").WorkloadTemplate) => void,
  options: {
    capabilities?: import("@pstdio/pocketcoder-contracts").WorkloadCapability[];
    base?: Awaited<ReturnType<typeof createPGliteFixture>>;
    ready?: boolean;
    mode?: "memory" | "disk";
  } = {},
) {
  const f = options.base ?? (await createPGliteFixture("execution-dispatch", options.mode ?? "memory"));
  const source = parseWorkloadTemplate(
    await Bun.file(new URL("../../../../../examples/workloads/finite-process.json", import.meta.url)).json(),
  ).manifest;
  configure?.(source);
  const adapter = source.spec.adapters.main;
  if (!adapter) throw new Error("Fixture adapter missing");
  const template = workloadSnapshotOf(parseWorkloadTemplate(source));
  const id = randomUUID();
  const result = await f.store.insertWorkspace({
    id,
    principalId: f.principal.id,
    externalId: id,
    idempotencyKey: id,
    requestDigest: id,
    templateId: f.template.id,
    templateSnapshot: { ...snapshotOf(f.parsed), digest: template.digest },
    launchInput: null,
    metadata: {},
    deadlineAt: new Date(Date.now() + 600_000),
    createdAt: new Date(),
  });
  if (result.kind !== "created") throw new Error("Workspace not created");
  const ref = { kind: "docker", id: "observed-container@start" };
  await f.store.transition(id, {
    from: ["queued"],
    to: "provisioning",
    at: new Date(),
    patch: { providerRef: ref, providerKind: "docker" },
  });
  const capabilities: import("@pstdio/pocketcoder-contracts").WorkloadCapability[] = options.capabilities ?? [
    "explicit-start",
    "exact-exit",
    "targeted-cancel",
    "request-lookup",
    "deduplicated-accept",
    "stop-before-export",
    "unknown-outcome",
  ];
  const runtime = {
    incarnationId: ref.id,
    containerIdentity: ref.id,
    profile: source.spec.profile,
    template,
    producer: {
      workspaceId: id,
      incarnationId: ref.id,
      templateDigest: template.digest,
      image: source.spec.image,
      runtime: source.spec.runtime,
      storage: { identity: "fixture-storage", profile: "controller-readonly/v1" as const },
      capabilities: capabilities,
      adapters: {
        main: {
          kind: adapter.kind,
          digest: adapter.digest,
          protocol: adapter.protocol,
          capabilities: capabilities,
        },
      },
    },
  };
  await f.store.bindWorkspaceRuntime(
    id,
    {
      ...runtime,
      producer: {
        ...runtime.producer,
        capabilities: [...runtime.producer.capabilities],
        adapters: {
          main: { ...runtime.producer.adapters.main, capabilities: [...runtime.producer.adapters.main.capabilities] },
        },
      },
    },
    ref,
  );
  await f.store.transition(id, {
    from: ["provisioning"],
    to: "connected",
    at: new Date(),
    patch: { connectionEpoch: 1 },
  });
  if (options.ready !== false) {
    await f.store.markWorkspaceRuntimeReady(id, ref.id, 1, new Date());
    await f.store.transition(id, { from: ["connected"], to: "ready", at: new Date() });
  }
  const acceptance = (requestId = randomUUID()): WorkloadAcceptance => {
    const contents = { workspaceId: id, incarnationId: ref.id, objects: [] };
    const facts = {
      execution: {
        workspaceId: id,
        incarnationId: ref.id,
        owner: adapter.kind === "process" ? ("process" as const) : ("conversation-request" as const),
        requestId,
      },
      callerPrincipalId: f.principal.id,
      templateDigest: template.digest,
      adapterDigest: adapter.digest,
      operation: "run",
      input: {},
      inputs: { ...contents, digest: digestOf(contents) },
      bindingSetDigest: digestOf([]),
    };
    return { ...facts, fingerprint: digestOf(facts) };
  };
  return { ...f, id, runtime, acceptance };
}
