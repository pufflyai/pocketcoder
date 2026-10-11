import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createRemoteExtension } from "./extension";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ENV_KEYS = ["POCKETCODER_URL", "POCKETCODER_KEY", "POCKETCODER_WORKSPACE_ID", "POCKETCODER_AGENTAPI_URL"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// A PocketCoder relay whose agent turn runs until it is interrupted.
function pocketCoder() {
  const requests: string[] = [];
  let running = false;
  let sending!: () => void;
  const promptSent = new Promise<void>((resolve) => {
    sending = resolve;
  });
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path.endsWith("/agent/messages")) return Response.json({ messages: [] });
      if (path.endsWith("/agent/status")) return Response.json({ status: running ? "running" : "stable" });
      if (request.method === "POST" && path.endsWith("/agent/message")) {
        running = true;
        sending();
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path.endsWith("/agent/interrupt")) {
        running = false;
        return Response.json({ status: "requested" });
      }
      return new Response("missing", { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: server.url.origin, requests, promptSent };
}

// Runs the extension inside a real Pi runtime, as the remote launcher does.
async function startPi(baseUrl: string) {
  Object.assign(process.env, {
    POCKETCODER_URL: baseUrl,
    POCKETCODER_KEY: "key",
    POCKETCODER_WORKSPACE_ID: WORKSPACE,
  });
  delete process.env.POCKETCODER_AGENTAPI_URL;
  const dir = mkdtempSync(join(tmpdir(), "remote-extension-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: { extensionFactories: [createRemoteExtension()] },
    });
    const model = services.modelRuntime.getModel("pocketcoder-agentapi", "remote-agent");
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: dir,
    agentDir,
    sessionManager: SessionManager.inMemory(dir),
  });
  await runtime.session.bindExtensions({});
  return runtime;
}

const interrupts = (requests: string[]) => requests.filter((request) => request.endsWith("/agent/interrupt"));

describe("remote extension interruption", () => {
  test("stops the remote turn when the user aborts the response", async () => {
    const remote = pocketCoder();
    const pi = await startPi(remote.url);
    const prompt = pi.session.prompt("hello");
    await remote.promptSent;

    await pi.session.abort();
    await prompt;

    expect(interrupts(remote.requests)).toEqual([`POST /v1/workspaces/${WORKSPACE}/agent/interrupt`]);
    await pi.dispose();
  });

  test("leaves the remote turn running when Pi quits", async () => {
    const remote = pocketCoder();
    const pi = await startPi(remote.url);
    const prompt = pi.session.prompt("hello");
    await remote.promptSent;

    await pi.dispose();
    await prompt;

    expect(interrupts(remote.requests)).toEqual([]);
  });
});
