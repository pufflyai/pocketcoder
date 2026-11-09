import { randomUUID } from "node:crypto";
import type { WorkloadAcceptance, WorkloadCapability } from "@pstdio/pocketcoder-contracts";
import { managedPolicy, serviceExecutionTemplate } from "@pstdio/pocketcoder-db/testing";
import { processDispatchFixture } from "../control-channel/process-dispatch-fixture.test";

type Execution = WorkloadAcceptance["execution"];
type Fact = { execution: Execution; fingerprint: string; phase: string; outcome?: unknown };

// A real HTTP producer. Each message selects its behavior; every call is journaled so tests can
// prove what reached the producer and what never did.
export function fakeProducer() {
  const facts = new Map<string, Fact>();
  const journal: { action: string; message?: string; requestId: string }[] = [];
  const messages = new Map<string, string>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/status") return Response.json({ status: "stable" });
      const body = (await request.json()) as { acceptance?: WorkloadAcceptance; execution?: Execution };
      const execution = body.acceptance?.execution ?? body.execution;
      const requestId = execution?.requestId ?? "";
      const action = path.split("/").at(-1) ?? "";
      if (action === "accept" && body.acceptance) {
        const message = String(body.acceptance.input.message);
        messages.set(requestId, message);
        journal.push({ action, message, requestId });
        const base = { execution: body.acceptance.execution, fingerprint: body.acceptance.fingerprint };
        const startedAt = new Date().toISOString();
        const fact: Fact = message.startsWith("complete")
          ? {
              ...base,
              phase: "terminal",
              outcome: { status: "completed", finalResponse: `done:${message}`, startedAt },
            }
          : { ...base, phase: "running", outcome: { startedAt } };
        facts.set(requestId, fact);
        return Response.json(fact);
      }
      journal.push({ action, message: messages.get(requestId), requestId });
      const known = facts.get(requestId);
      if (action === "cancel" && known && known.phase === "running") {
        // The producer had already written its final text when the stop arrived.
        const fact = {
          ...known,
          phase: "terminal",
          outcome: { status: "interrupted", finalResponse: "partial answer" },
        };
        facts.set(requestId, fact);
        return Response.json(fact);
      }
      if (action === "ack") return new Response("", { status: 200 });
      return Response.json(known ?? { execution, phase: "absent" });
    },
  });
  return {
    server,
    journal,
    // Lets a running request finish as the producer would on its own.
    complete(requestId: string, finalResponse: string) {
      const known = facts.get(requestId);
      if (known) facts.set(requestId, { ...known, phase: "terminal", outcome: { status: "completed", finalResponse } });
    },
    sent: (message: string) => journal.filter((entry) => entry.action === "accept" && entry.message === message),
  };
}

const CAPABILITIES: WorkloadCapability[] = [
  "explicit-start",
  "exact-exit",
  "targeted-cancel",
  "request-lookup",
  "deduplicated-accept",
  "stop-before-export",
  "unknown-outcome",
  "parallel-conversations",
];

// One shared workspace, an installation budget scope and a credential-free profile.
export async function managedFixture(port: number | undefined) {
  const configure = (source: import("@pstdio/pocketcoder-contracts").WorkloadTemplate) => {
    serviceExecutionTemplate(source, Number(port));
    const run = source.spec.operations.run;
    if (!run) throw Error("Missing operation");
    source.spec.operations = {
      message: {
        ...run,
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    };
  };
  const f = await processDispatchFixture(configure, undefined, { capabilities: CAPABILITIES });
  // Another launched workspace of the same template, sharing the store and connection hub.
  const launch = () => processDispatchFixture(configure, f, { capabilities: CAPABILITIES });
  const keyId = randomUUID();
  const scopeId = randomUUID();
  const profileId = randomUUID();
  await f.store.insertMachineKey({
    id: keyId,
    principalId: f.principal.id,
    secretDigest: new Uint8Array([7]),
    scopes: ["admin"],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 600000),
    revokedAt: null,
    lastUsedAt: null,
  });
  await f.store.publishTemplate(keyId, f.runtime.template.manifest);
  await f.store.managed.authority.registerScope(keyId, scopeId, f.principal.id, true);
  await f.store.managed.authority.provisionProfile(keyId, f.principal.id, {
    profileId,
    revision: 1,
    isolationScopeId: randomUUID(),
    budgetScopeIds: [scopeId],
    templateDigest: f.runtime.template.digest,
    credentialBindingId: null,
  });
  const policy = managedPolicy(scopeId);
  policy.limits.maxChatProcessesPerWorkspace = 8;
  await f.store.managed.budgets.writePolicy(keyId, policy, null);
  const limits = { count: 4, bytes: 1048576 };
  async function session() {
    const sessionId = randomUUID();
    await f.store.managed.sessions.create(keyId, { sessionId, profileId, profileRevision: 1 });
    await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId }, 0, {
      workspaceId: f.id,
      incarnationId: f.runtime.incarnationId,
      generation: 1,
    });
    return sessionId;
  }
  async function submit(sessionId: string, message: string) {
    const requestId = randomUUID();
    const deadline = new Date(Date.now() + 60000).toISOString();
    await f.store.managed.requests.accept(
      keyId,
      sessionId,
      { requestId, message, attachments: [], dispatchDeadline: deadline },
      limits,
    );
    return requestId;
  }
  async function settle(rounds = 3) {
    for (let i = 0; i < rounds; i++) {
      await f.dispatcher.tick();
      await f.dispatcher.drain();
    }
  }
  const request = (sessionId: string, requestId: string) => f.store.managed.requests.get(keyId, sessionId, requestId);
  return { f, launch, keyId, scopeId, profileId, limits, session, submit, settle, request };
}
