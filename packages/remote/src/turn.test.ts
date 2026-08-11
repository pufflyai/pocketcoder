import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import {
  type WorkspaceResource,
  WorkspaceTurnResolutionError,
  WorkspaceTurnResolver,
} from "@pstdio/pocketcoder-sdk";
import { captureTurnAttachmentBatch } from "./attachments";
import { ControlPlaneClient } from "./control-plane";
import { RemoteRequestError } from "./remote-request-error";
import { relayTarget } from "./session-target";
import { executeRemoteTurn, type RemoteTurnResolver } from "./turn";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CHECKPOINT = "33333333-3333-4333-8333-333333333333";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(id: string, overrides: Partial<WorkspaceResource> = {}): WorkspaceResource {
  const state = overrides.state ?? "ready";
  return {
    id,
    external_id: `turn-${id.slice(0, 4)}`,
    template: { name: "pi", version: "1", digest: "sha256:pi" },
    state,
    reason_code: null,
    agent_state: "stable",
    change_cursor: 1,
    provider_kind: "docker",
    provisioning_mode: "cold",
    network: { state: "ready" },
    health: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    connected_at: "2026-01-01T00:00:00Z",
    ready_at: state === "ready" ? "2026-01-01T00:00:00Z" : null,
    deadline_at: "2026-01-01T01:00:00Z",
    terminal_at: state === "preserved" ? "2026-01-01T00:10:00Z" : null,
    metadata: {},
    origin_workspace_id: id === B ? A : null,
    restored_from_checkpoint_id: id === B ? CHECKPOINT : null,
    source: null,
    persistence: {
      enabled: true,
      conversation_restore: "supported",
      conversation_resume: { status: "supported", reason: null },
      latest_checkpoint_id: CHECKPOINT,
    },
    outputs: {},
    failure: null,
    ...overrides,
  };
}

function context(text = "hello"): Context {
  return { messages: [{ role: "user", content: text, timestamp: 0 }] } as unknown as Context;
}

function terminal() {
  return Response.json(
    {
      error: {
        code: "workspace.terminal",
        message: "workspace detail",
        request_id: "request-secret",
      },
    },
    { status: 410 },
  );
}

interface HarnessOptions {
  failPhase?: "initial_messages" | "attachment" | "submit" | "reply_messages";
  failWorkspaces?: string[];
  controlPlaneGet?: (id: string) => WorkspaceResource;
}

interface HarnessState {
  options: HarnessOptions;
  submitted: Set<string>;
  failures: Set<string>;
}

function attachmentResponse(
  request: Request,
  workspaceId: string | undefined,
  state: HarnessState,
): Response | undefined {
  const path = new URL(request.url).pathname;
  if (!path.includes("/attachments/")) return undefined;
  if (
    state.options.failPhase === "attachment" &&
    workspaceId &&
    state.failures.delete(workspaceId)
  ) {
    return terminal();
  }
  const id = path.split("/").at(-1) as string;
  return Response.json(
    {
      id,
      name: "file.txt",
      path: `/tmp/${id}/file.txt`,
      media_type: "text/plain",
      size_bytes: Number(request.headers.get("content-length")),
      sha256: "a".repeat(64),
    },
    { status: 201 },
  );
}

function messagesResponse(
  workspaceId: string | undefined,
  targetId: string,
  state: HarnessState,
): Response {
  const beforeSubmit = !state.submitted.has(targetId);
  const phase = beforeSubmit ? "initial_messages" : "reply_messages";
  if (state.options.failPhase === phase && workspaceId && state.failures.delete(workspaceId)) {
    return terminal();
  }
  return Response.json({
    messages: beforeSubmit ? [] : [{ id: 1, role: "agent", content: `reply from ${targetId}` }],
  });
}

function routeHarnessRequest(request: Request, state: HarnessState): Response {
  const path = new URL(request.url).pathname;
  const workspaceId = path.match(/\/v1\/workspaces\/([^/]+)/)?.[1];
  const targetId = workspaceId ?? "direct";
  if (request.method === "GET" && workspaceId && path === `/v1/workspaces/${workspaceId}`) {
    return Response.json(state.options.controlPlaneGet?.(workspaceId) ?? workspace(workspaceId));
  }
  const attachment = attachmentResponse(request, workspaceId, state);
  if (attachment) return attachment;
  if (path.endsWith("/messages")) return messagesResponse(workspaceId, targetId, state);
  if (path.endsWith("/events")) return new Response(null, { status: 404 });
  if (request.method === "POST" && path.endsWith("/message")) {
    if (state.options.failPhase === "submit" && state.failures.delete(targetId)) return terminal();
    state.submitted.add(targetId);
    return Response.json({ ok: true });
  }
  if (path.endsWith("/status")) return Response.json({ status: "stable" });
  return new Response("missing", { status: 404 });
}

function fetchHarness(options: HarnessOptions) {
  const requests: Request[] = [];
  const state: HarnessState = {
    options,
    submitted: new Set(),
    failures: new Set(options.failWorkspaces ?? [A]),
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    requests.push(request);
    return routeHarnessRequest(request, state);
  }) as typeof fetch;
  const controlPlane = new ControlPlaneClient(
    { baseUrl: "http://pocketcoder.test", key: "key" },
    fetchImpl,
  );
  return { fetchImpl, controlPlane, requests };
}

function resolverSequence(ids: string[], calls: string[]): RemoteTurnResolver {
  return {
    resolve: async (sourceWorkspaceId) => {
      calls.push(sourceWorkspaceId);
      const id = ids.shift() ?? sourceWorkspaceId;
      return { workspace: workspace(id), resumed: id !== sourceWorkspaceId };
    },
  };
}

function queuedFile() {
  const dir = mkdtempSync(join(tmpdir(), "remote-turn-"));
  dirs.push(dir);
  const file = join(dir, "file.txt");
  writeFileSync(file, "payload");
  return file;
}

describe("executeRemoteTurn", () => {
  test("uses the real SDK resolver for a preserved source and returns ready B", async () => {
    const harness = fetchHarness({
      controlPlaneGet: (id) => (id === A ? workspace(A, { state: "preserved" }) : workspace(B)),
    });
    const resolver = new WorkspaceTurnResolver({
      client: harness.controlPlane,
      resumeWorkspace: async () => workspace(B),
    });

    const result = await executeRemoteTurn({
      target: relayTarget("http://pocketcoder.test", "key", A),
      controlPlane: harness.controlPlane,
      resolver,
      attachmentBatch: captureTurnAttachmentBatch(context(), []),
      prompt: "hello",
      fetch: harness.fetchImpl,
    });

    expect(result.workspace?.id).toBe(B);
    expect(result.workspaceId).toBe(B);
    expect(result.text).toBe(`reply from ${B}`);
  });

  test("retries one verified pre-acceptance terminal race", async () => {
    for (const failPhase of ["initial_messages", "attachment", "submit"] as const) {
      const harness = fetchHarness({ failPhase });
      const calls: string[] = [];
      const queue = failPhase === "attachment" ? [queuedFile()] : [];
      const result = await executeRemoteTurn({
        target: relayTarget("http://pocketcoder.test", "key", A),
        controlPlane: harness.controlPlane,
        resolver: resolverSequence([A, B], calls),
        attachmentBatch: captureTurnAttachmentBatch(context(), queue),
        prompt: "hello",
        fetch: harness.fetchImpl,
      });

      expect(result.workspaceId).toBe(B);
      expect(calls).toEqual([A, A]);
      expect(queue).toEqual([]);
    }
  });

  test("never retries after prompt acceptance", async () => {
    const harness = fetchHarness({ failPhase: "reply_messages" });
    const calls: string[] = [];
    const file = queuedFile();
    const queue = [file];

    await executeRemoteTurn({
      target: relayTarget("http://pocketcoder.test", "key", A),
      controlPlane: harness.controlPlane,
      resolver: resolverSequence([A, B], calls),
      attachmentBatch: captureTurnAttachmentBatch(context(), queue),
      prompt: "hello",
      fetch: harness.fetchImpl,
    }).then(
      () => {
        throw new Error("expected turn to fail");
      },
      (error) => {
        expect(error).toBeInstanceOf(RemoteRequestError);
        expect(error).toMatchObject({ promptAccepted: true, phase: "reply_messages" });
      },
    );
    expect(calls).toEqual([A]);
    expect(queue).toEqual([]);
  });

  test("permits at most one generation retry", async () => {
    const harness = fetchHarness({ failPhase: "initial_messages", failWorkspaces: [A, B] });
    const calls: string[] = [];
    await expect(
      executeRemoteTurn({
        target: relayTarget("http://pocketcoder.test", "key", A),
        controlPlane: harness.controlPlane,
        resolver: resolverSequence([A, B, B], calls),
        attachmentBatch: captureTurnAttachmentBatch(context(), []),
        prompt: "hello",
        fetch: harness.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(RemoteRequestError);
    expect(calls).toEqual([A, A]);
  });

  test("uses a fixed no-handler error and preserves resolver failures", async () => {
    const terminalHarness = fetchHarness({ failPhase: "initial_messages" });
    await expect(
      executeRemoteTurn({
        target: relayTarget("http://pocketcoder.test", "key", A),
        controlPlane: terminalHarness.controlPlane,
        attachmentBatch: captureTurnAttachmentBatch(context(), []),
        prompt: "hello",
        fetch: terminalHarness.fetchImpl,
      }),
    ).rejects.toThrow("workspace resume handler is not configured");

    const failure = new WorkspaceTurnResolutionError("not_resumable");
    const resolver: RemoteTurnResolver = { resolve: async () => Promise.reject(failure) };
    await expect(
      executeRemoteTurn({
        target: relayTarget("http://pocketcoder.test", "key", A),
        controlPlane: terminalHarness.controlPlane,
        resolver,
        attachmentBatch: captureTurnAttachmentBatch(context(), []),
        prompt: "hello",
        fetch: terminalHarness.fetchImpl,
      }),
    ).rejects.toBe(failure);
  });

  test("bypasses resolution in direct mode", async () => {
    const harness = fetchHarness({});
    let resolutions = 0;
    const result = await executeRemoteTurn({
      target: { mode: "direct", key: "key", serviceUrl: "http://pocketcoder.test/direct" },
      resolver: {
        resolve: async () => {
          resolutions += 1;
          throw new Error("direct mode must not resolve");
        },
      },
      attachmentBatch: captureTurnAttachmentBatch(context(), []),
      prompt: "hello",
      fetch: harness.fetchImpl,
    });
    expect(result.workspaceId).toBeUndefined();
    expect(resolutions).toBe(0);
  });
});
