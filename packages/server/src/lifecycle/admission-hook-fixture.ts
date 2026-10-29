import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { DEFAULT_LIMITS, OutboxDispatcher, type Store } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { loadConfig } from "../config/config";
import { createMaintenance } from "../maintenance/maintenance";
import { Readiness } from "../observability/health";
import { authed, createTestServer, SERVER_TEST_PEPPER } from "../testing/test-server.test";
import { startBackgroundTimers } from "./background-timers";
import { createLaunchPolicy } from "./launch-policy";
import { PolicyReconciliation } from "./policy-reconciliation";

const HOOK_TOKEN = "test-admission-hook-control-token";

interface HookPrincipal {
  id: string;
  templates: string[];
}

// An external admission hook that can only decide once it has read its
// principal map from the controller, like Onefin's accounting hook.
function startAdmissionHook() {
  const state = {
    principals: undefined as HookPrincipal[] | undefined,
    pending: [] as string[],
    unproven: new Set<string>(),
    reconciled: [] as string[],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${HOOK_TOKEN}`) return new Response(null, { status: 401 });
      if (!state.principals) return new Response("starting", { status: 503 });
      const path = new URL(request.url).pathname;
      if (path === "/v1/admission/pending") return Response.json({ workspace_ids: state.pending });
      const body = (await request.json()) as { workspace_id: string; principal_id: string; template_name: string };
      if (path === "/v1/admission/reconcile") {
        state.reconciled.push(body.workspace_id);
        if (state.unproven.has(body.workspace_id))
          return Response.json({ workspace_id: body.workspace_id, released: false, reason: "termination-unproven" });
        state.pending = state.pending.filter((id) => id !== body.workspace_id);
        return Response.json({ workspace_id: body.workspace_id, released: true });
      }
      const principal = state.principals.find((candidate) => candidate.id === body.principal_id);
      if (!principal?.templates.includes(body.template_name)) return Response.json({ allowed: false }, { status: 403 });
      return Response.json({ allowed: true, workspace_id: body.workspace_id });
    },
  });
  return {
    url: `${server.url}v1/admission`,
    state,
    // The hook reads its configuration from the controller before it admits anything.
    async start(controllerUrl: string, token: string) {
      const response = await fetch(`${controllerUrl}/v1/principals`, authed(token));
      if (!response.ok) throw new Error(`hook could not read principals: ${response.status}`);
      state.principals = ((await response.json()) as { items: HookPrincipal[] }).items;
    },
    stop: () => server.stop(true),
  };
}

async function insertAdminKey(store: Store) {
  const principal = await store.createPrincipal("admission-hook", ["admin"], ["*"]);
  const key = issueMachineKey(SERVER_TEST_PEPPER);
  await store.insertMachineKey({
    id: key.id,
    principalId: principal.id,
    secretDigest: key.secretDigest,
    scopes: ["admin"],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  return key.token;
}

// Composes the controller the way lifecycle.ts does: real store, real launch
// policy and policy reconciliation over HTTP, and the real background timers.
export async function startControllerWithAdmissionHook(store: Store) {
  const base = await createTestServer(store);
  const adminToken = await insertAdminKey(store);
  const hook = startAdmissionHook();
  const readiness = new Readiness({ "policy-reconciliation": "pending" });
  const built = buildServer({
    store,
    driver: base.driver,
    pepper: SERVER_TEST_PEPPER,
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:0",
    authorizeLaunch: createLaunchPolicy(hook.url, HOOK_TOKEN),
    readiness,
  });
  const directory = await mkdtemp(join(tmpdir(), "pc-admission-hook-"));
  const config = loadConfig({
    POCKETCODER_DIR: directory,
    POCKETCODER_AUTH_PEPPER: SERVER_TEST_PEPPER,
    POCKETCODER_SCHEDULER_INTERVAL_MS: "20",
  });
  const timers = startBackgroundTimers({
    ...built,
    config,
    store,
    readiness,
    maintenance: createMaintenance(),
    log: () => {},
    outbox: new OutboxDispatcher({ store, sinkUrl: null, sign: () => "" }),
    policyReconciliation: new PolicyReconciliation(store, hook.url, HOOK_TOKEN),
  });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: built.app.fetch, websocket: built.websocket });
  const url = listener.url.origin;
  return {
    url,
    hook,
    driver: base.driver,
    token: base.token,
    adminToken,
    request: (path: string, token = adminToken, init: RequestInit = {}) => fetch(`${url}${path}`, authed(token, init)),
    startHook: () => hook.start(url, adminToken),
    async stop() {
      await timers.stop();
      await listener.stop(true);
      await hook.stop();
      await built.scheduler.drain();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function waitFor(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await Bun.sleep(20);
  }
}
