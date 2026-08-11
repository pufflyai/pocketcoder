import { describe, expect, test } from "bun:test";
import type { WorkspaceResource } from "@pstdio/pocketcoder-contracts";
import { PocketCoderClient, WorkspaceTurnResolutionError, WorkspaceTurnResolver } from "./index";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const CHECKPOINT = "22222222-2222-4222-8222-222222222222";
const RESUMED = "33333333-3333-4333-8333-333333333333";

function workspace(overrides: Partial<WorkspaceResource> = {}): WorkspaceResource {
  const state = overrides.state ?? "ready";
  return {
    id: SOURCE,
    external_id: "turn-source",
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
    terminal_at: ["preserved", "failed", "canceled", "expired", "succeeded"].includes(state)
      ? "2026-01-01T00:10:00Z"
      : null,
    metadata: {},
    origin_workspace_id: null,
    restored_from_checkpoint_id: null,
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

function resumed(overrides: Partial<WorkspaceResource> = {}): WorkspaceResource {
  return workspace({
    id: RESUMED,
    external_id: "turn-resumed",
    origin_workspace_id: SOURCE,
    restored_from_checkpoint_id: CHECKPOINT,
    ...overrides,
  });
}

function fixtureClient(
  route: (request: Request) => Response | Promise<Response>,
  requests: Request[] = [],
) {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    requests.push(request);
    return await route(request);
  }) as typeof fetch;
  return new PocketCoderClient(
    { baseUrl: "http://pocketcoder.test", apiKey: "pkt_example", maxRetries: 0 },
    fetchImpl,
  );
}

function errorCode(error: unknown) {
  expect(error).toBeInstanceOf(WorkspaceTurnResolutionError);
  return (error as WorkspaceTurnResolutionError).code;
}

describe("WorkspaceTurnResolver", () => {
  test("returns a ready source without a resume handler", async () => {
    const client = fixtureClient(() => Response.json(workspace()));
    const resolver = new WorkspaceTurnResolver({ client });

    await expect(resolver.resolve(SOURCE)).resolves.toEqual({
      workspace: workspace(),
      resumed: false,
    });
  });

  test("waits for preservation, validates the resumed generation, and waits for ready", async () => {
    const requests: Request[] = [];
    let sourceReads = 0;
    const client = fixtureClient((request) => {
      const path = new URL(request.url).pathname;
      if (path === `/v1/workspaces/${SOURCE}`) {
        sourceReads += 1;
        return Response.json(workspace({ state: "preserving" }));
      }
      if (path === `/v1/workspaces/${SOURCE}/changes`) {
        return Response.json({
          cursor: 2,
          changed: true,
          workspace: workspace({ state: "preserved", change_cursor: 2 }),
        });
      }
      if (path === `/v1/workspaces/${RESUMED}`) {
        return Response.json(resumed({ state: "queued" }));
      }
      if (path === `/v1/workspaces/${RESUMED}/changes`) {
        return Response.json({
          cursor: 2,
          changed: true,
          workspace: resumed({ state: "ready", change_cursor: 2 }),
        });
      }
      return new Response("missing", { status: 404 });
    }, requests);
    const attempts: string[] = [];
    const resolver = new WorkspaceTurnResolver({
      client,
      resumeWorkspace: async ({ source, attemptId, signal }) => {
        expect(source.state).toBe("preserved");
        expect(signal.aborted).toBe(false);
        attempts.push(attemptId);
        return resumed({ state: "queued" });
      },
    });

    const result = await resolver.resolve(SOURCE);

    expect(result.workspace.state).toBe("ready");
    expect(result.resumed).toBe(true);
    expect(attempts[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sourceReads).toBe(1);
    expect(
      requests.some((request) => request.url.endsWith(`/${RESUMED}/changes?after=1&wait=30`)),
    ).toBe(true);
  });

  test("rejects unsupported and non-resumable terminal sources", async () => {
    for (const source of [
      workspace({ state: "failed" }),
      workspace({
        state: "preserved",
        persistence: {
          ...workspace().persistence,
          conversation_resume: { status: "unsupported", reason: "filesystem_only" },
        },
      }),
    ]) {
      const resolver = new WorkspaceTurnResolver({
        client: fixtureClient(() => Response.json(source)),
      });
      await resolver.resolve(SOURCE).then(
        () => {
          throw new Error("expected resolution to fail");
        },
        (error) => expect(errorCode(error)).toBe("not_resumable"),
      );
    }
  });

  test("uses a stable no-handler failure for a preserved source", async () => {
    const resolver = new WorkspaceTurnResolver({
      client: fixtureClient(() => Response.json(workspace({ state: "preserved" }))),
    });

    await resolver.resolve(SOURCE).then(
      () => {
        throw new Error("expected resolution to fail");
      },
      (error) => {
        expect(errorCode(error)).toBe("resume_handler_missing");
        expect((error as Error).message).toBe("workspace resume handler is not configured");
      },
    );
  });

  test("coalesces concurrent callers into one live resume attempt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callbackCalls = 0;
    const client = fixtureClient((request) => {
      const path = new URL(request.url).pathname;
      return Response.json(path.endsWith(RESUMED) ? resumed() : workspace({ state: "preserved" }));
    });
    const resolver = new WorkspaceTurnResolver({
      client,
      resumeWorkspace: async () => {
        callbackCalls += 1;
        await gate;
        return resumed();
      },
    });

    const first = resolver.resolve(SOURCE);
    const second = resolver.resolve(SOURCE);
    await Bun.sleep(0);
    expect(callbackCalls).toBe(1);
    release();
    expect((await first).workspace.id).toBe(RESUMED);
    expect((await second).workspace.id).toBe(RESUMED);
  });

  test("caller abort stops only that wait after resume starts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callbackCalls = 0;
    const client = fixtureClient((request) =>
      Response.json(
        new URL(request.url).pathname.endsWith(RESUMED)
          ? resumed()
          : workspace({ state: "preserved" }),
      ),
    );
    const resolver = new WorkspaceTurnResolver({
      client,
      resumeWorkspace: async () => {
        callbackCalls += 1;
        await gate;
        return resumed();
      },
    });
    const controller = new AbortController();
    const canceled = resolver.resolve(SOURCE, { signal: controller.signal });
    await Bun.sleep(0);
    controller.abort(new Error("caller left"));
    await expect(canceled).rejects.toThrow("caller left");

    const joined = resolver.resolve(SOURCE);
    release();
    expect((await joined).workspace.id).toBe(RESUMED);
    expect(callbackCalls).toBe(1);
  });

  test("does not start resume when the last caller aborts during preservation", async () => {
    let callbackCalls = 0;
    const client = fixtureClient(async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/changes")) {
        await new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        });
      }
      return Response.json(workspace({ state: "preserving" }));
    });
    const resolver = new WorkspaceTurnResolver({
      client,
      resumeWorkspace: async () => {
        callbackCalls += 1;
        return resumed();
      },
    });
    const controller = new AbortController();
    const result = resolver.resolve(SOURCE, { signal: controller.signal });
    await Bun.sleep(0);
    controller.abort(new Error("caller left"));

    await expect(result).rejects.toThrow("caller left");
    await Bun.sleep(0);
    expect(callbackCalls).toBe(0);
  });

  test("rejects an unrelated resumed workspace", async () => {
    const client = fixtureClient((request) => {
      const path = new URL(request.url).pathname;
      return Response.json(
        path.endsWith(RESUMED)
          ? resumed({ origin_workspace_id: "44444444-4444-4444-8444-444444444444" })
          : workspace({ state: "preserved" }),
      );
    });
    const resolver = new WorkspaceTurnResolver({
      client,
      resumeWorkspace: async () => resumed(),
    });

    await resolver.resolve(SOURCE).then(
      () => {
        throw new Error("expected resolution to fail");
      },
      (error) => expect(errorCode(error)).toBe("invalid_resumed_workspace"),
    );
  });

  test("sanitizes callback, terminal launch, and readiness timeout failures", async () => {
    const sourceClient = fixtureClient(() => Response.json(workspace({ state: "preserved" })));
    const callbackFailure = new WorkspaceTurnResolver({
      client: sourceClient,
      resumeWorkspace: async () => {
        throw new Error("secret bootstrap token");
      },
    });
    await callbackFailure.resolve(SOURCE).catch((error) => {
      expect(errorCode(error)).toBe("resume_failed");
      expect((error as Error).message).not.toContain("secret");
    });

    for (const resumedState of ["failed", "queued"] as const) {
      const client = fixtureClient((request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith(RESUMED)) return Response.json(resumed({ state: resumedState }));
        if (path.endsWith("/changes")) {
          return Response.json({
            cursor: 2,
            changed: false,
            workspace: resumed({ state: resumedState }),
          });
        }
        return Response.json(workspace({ state: "preserved" }));
      });
      const resolver = new WorkspaceTurnResolver({
        client,
        resumeTimeoutMs: resumedState === "queued" ? 1 : 100,
        resumeWorkspace: async () => resumed({ state: resumedState }),
      });
      await resolver.resolve(SOURCE).catch((error) => {
        expect(errorCode(error)).toBe("readiness_failed");
        expect((error as Error).message).toBe("resumed workspace did not become ready");
      });
    }
  });
});
