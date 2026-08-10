import { describe, expect, test } from "bun:test";
import {
  agentApiHarness,
  findRoute,
  isAgentApiNative,
  parseTemplateManifest,
  snapshotOf,
  templateServices,
} from "./index";

const DIGEST = "a".repeat(64);

function baseManifest(): Record<string, unknown> {
  return {
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "fixture", description: "test" },
    spec: {
      version: "1.0.0",
      image: `registry.test/agent@sha256:${DIGEST}`,
      harness: { command: ["agentapi", "server", "--", "claude"] },
      resources: { cpu: "2", memory: "2Gi" },
      services: {
        agent: {
          baseUrl: "http://127.0.0.1:3284",
          routes: [
            { method: "GET", path: "/status" },
            { method: "POST", path: "/message" },
          ],
        },
      },
    },
  };
}

function nativeManifest(): Record<string, unknown> {
  const manifest = baseManifest();
  const spec = manifest.spec as Record<string, unknown>;
  delete spec.harness;
  delete spec.services;
  spec.agent = {
    type: "codex",
    command: ["codex", "--full-auto"],
    cwd: "/workspace",
    env: { CODEX_HOME: "/state/codex" },
  };
  return manifest;
}

describe("template manifest", () => {
  test("parses with defaults applied", () => {
    const parsed = parseTemplateManifest(baseManifest());
    expect(parsed.manifest.spec.timeouts.maxAge).toBe("2h");
    expect(parsed.manifest.spec.security.uid).toBe(10001);
    expect(parsed.manifest.spec.setup).toEqual([]);
    expect(parsed.manifest.spec.command[0]).toContain("pocketcoder-supervisor");
    expect(parsed.manifest.spec.network).toEqual({ mode: "unrestricted" });
    expect(parsed.digest.startsWith("sha256:")).toBe(true);
  });

  test("accepts reviewed restricted networking and rejects proxy overrides", () => {
    const restricted = baseManifest();
    (restricted.spec as Record<string, unknown>).network = {
      mode: "restricted",
      allow: [{ domain: "github.com" }, { domain: "*.example.com", ports: [8443] }],
    };
    const parsed = parseTemplateManifest(restricted);
    expect(parsed.manifest.spec.network.mode).toBe("restricted");

    for (const key of ["HTTP_PROXY", "https_proxy", "No_Proxy", "all_proxy"]) {
      const manifest = structuredClone(restricted);
      (manifest.spec as { env?: Record<string, string> }).env = { [key]: "http://proxy" };
      expect(() => parseTemplateManifest(manifest)).toThrow("reserved by restricted networking");
    }
  });

  test("derives the fixed AgentAPI boundary from a coding-agent command", () => {
    const parsed = parseTemplateManifest(nativeManifest());
    const spec = parsed.manifest.spec;
    expect(isAgentApiNative(spec)).toBe(true);
    expect(agentApiHarness(spec)).toEqual({
      command: [
        "/usr/local/bin/agentapi",
        "server",
        "--type",
        "codex",
        "--port",
        "3284",
        "--",
        "codex",
        "--full-auto",
      ],
      cwd: "/workspace",
      env: { CODEX_HOME: "/state/codex" },
    });
    expect(Object.keys(templateServices(spec))).toEqual(["agent"]);
    expect(findRoute(snapshotOf(parsed), "agent", "GET", "/messages")).not.toBeNull();
    expect(findRoute(snapshotOf(parsed), "agent", "GET", "/events")).not.toBeNull();
    const legacySnapshot = snapshotOf(parsed);
    delete legacySnapshot.services;
    expect(findRoute(legacySnapshot, "agent", "GET", "/events")).toBeNull();
  });

  test("rejects ambiguous native and legacy ownership", () => {
    const withHarness = nativeManifest();
    (withHarness.spec as Record<string, unknown>).harness = { command: ["custom-wrapper"] };
    expect(() => parseTemplateManifest(withHarness)).toThrow("cannot be combined");

    const withServices = nativeManifest();
    (withServices.spec as Record<string, unknown>).services = {};
    expect(() => parseTemplateManifest(withServices)).toThrow("cannot be combined");
  });

  test("digest is independent of key order", () => {
    const a = parseTemplateManifest(baseManifest());
    const reordered = JSON.parse(JSON.stringify(baseManifest())) as Record<string, unknown>;
    const spec = reordered.spec as Record<string, unknown>;
    const { version, ...rest } = spec;
    reordered.spec = { ...rest, version };
    const b = parseTemplateManifest(reordered);
    expect(a.digest).toBe(b.digest);
  });

  test("digest changes when content changes", () => {
    const m = baseManifest();
    (m.spec as { version: string }).version = "1.0.1";
    expect(parseTemplateManifest(m).digest).not.toBe(parseTemplateManifest(baseManifest()).digest);
  });

  test("rejects images that are not digest-pinned", () => {
    const m = baseManifest();
    (m.spec as { image: string }).image = "registry.test/agent:latest";
    expect(() => parseTemplateManifest(m)).toThrow();
  });

  test("rejects non-loopback service baseUrl", () => {
    const m = baseManifest();
    const services = (m.spec as { services: Record<string, { baseUrl: string }> }).services;
    (services.agent as { baseUrl: string }).baseUrl = "http://10.0.0.5:3284";
    expect(() => parseTemplateManifest(m)).toThrow();
  });

  test("rejects traversal and unnormalized route paths", () => {
    for (const path of ["../etc", "/a/../b", "//double", "/query?x=1", "/space here"]) {
      const m = baseManifest();
      const services = (
        m.spec as {
          services: Record<string, { routes: Array<{ method: string; path: string }> }>;
        }
      ).services;
      services.agent = {
        routes: [{ method: "GET", path }],
      } as never;
      expect(() => parseTemplateManifest(m)).toThrow();
    }
  });

  test("rejects secret-looking env literals but allows references", () => {
    const bad = baseManifest();
    (bad.spec as { env?: Record<string, string> }).env = { API_TOKEN: "sk-live-abc" };
    expect(() => parseTemplateManifest(bad)).toThrow();

    const good = baseManifest();
    (good.spec as { env?: Record<string, string> }).env = {
      API_TOKEN: "secretRef:agentgateway/token",
    };
    expect(() => parseTemplateManifest(good)).not.toThrow();

    const malformed = baseManifest();
    (malformed.spec as { checkpointHook?: unknown }).checkpointHook = {
      command: ["/bin/true"],
      env: { API_TOKEN: "secretRef:../escape" },
    };
    expect(() => parseTemplateManifest(malformed)).toThrow();

    const output = baseManifest();
    (output.spec as { outputs?: unknown }).outputs = {
      "api-token": { type: "string" },
    };
    expect(() => parseTemplateManifest(output)).toThrow();
  });
});

describe("template terminal", () => {
  test("normalizes an opt-in terminal for native and legacy templates", () => {
    for (const manifest of [baseManifest(), nativeManifest()]) {
      (manifest.spec as Record<string, unknown>).terminal = {
        command: ["/bin/bash", "-l"],
        cwd: "/workspace",
        env: { TERMINAL_TOKEN: "secretRef:terminal/token" },
      };
      const terminal = parseTemplateManifest(manifest).manifest.spec.terminal;
      expect(terminal).toMatchObject({
        command: ["/bin/bash", "-l"],
        cwd: "/workspace",
        maxSessions: 2,
        idleTimeout: "10m",
      });
    }
    const rootCwd = baseManifest();
    (rootCwd.spec as Record<string, unknown>).terminal = {
      command: ["/bin/sh"],
      cwd: "/",
    };
    expect(() => parseTemplateManifest(rootCwd)).not.toThrow();
  });

  test("rejects terminal path traversal, limits, and secret literals", () => {
    const invalid = [
      { command: ["/bin/sh"], cwd: "/workspace/../escape" },
      { command: ["/bin/sh"], maxSessions: 9 },
      { command: ["/bin/sh"], env: { API_TOKEN: "literal-secret" } },
    ];
    for (const terminal of invalid) {
      const manifest = baseManifest();
      (manifest.spec as Record<string, unknown>).terminal = terminal;
      expect(() => parseTemplateManifest(manifest)).toThrow();
    }
  });
});

describe("template persistence and routing", () => {
  test("custom setup commands and harness survive the snapshot", () => {
    const m = baseManifest();
    (m.spec as { setup?: unknown }).setup = [
      { name: "install", command: ["bun", "install"], timeoutSeconds: 60 },
    ];
    const snapshot = snapshotOf(parseTemplateManifest(m));
    expect(snapshot.spec.setup[0]?.command).toEqual(["bun", "install"]);
    expect(agentApiHarness(snapshot.spec).command[0]).toBe("agentapi");
    expect(snapshot.spec.setup[0]?.runOn).toEqual(["create"]);
  });

  test("validates operator-owned persistence, source, and restore policy", () => {
    const manifest = baseManifest();
    const spec = manifest.spec as Record<string, unknown>;
    spec.security = { writableMemoryPaths: ["/tmp"] };
    spec.persistence = {
      mounts: [
        {
          name: "worktree",
          target: "/workspace",
          maxBytes: 1024,
          maxFiles: 10,
        },
        {
          name: "agent-state",
          target: "/state/agentapi",
          maxBytes: 1024,
          maxFiles: 10,
        },
      ],
      conversationRestore: "supported",
      sessionCompatibility: "agentapi-0.12",
    };
    spec.source = {
      kind: "git",
      destinationMount: "worktree",
      repositories: {
        pocketcoder: {
          url: "https://github.com/example/pocketcoder.git",
          credential: "secretRef:git/pocketcoder",
        },
      },
    };
    const parsed = parseTemplateManifest(manifest);
    expect(parsed.manifest.spec.persistence.mounts[0]?.target).toBe("/workspace");
    expect(parsed.manifest.spec.source?.repositories.pocketcoder?.url).toContain("github.com");
  });

  test("rejects persistence overlap, protected paths, and unreviewed source destinations", () => {
    for (const target of ["/", "/run/pocketcoder/secrets/token", "/proc/state"]) {
      const manifest = baseManifest();
      const spec = manifest.spec as Record<string, unknown>;
      spec.persistence = {
        mounts: [{ name: "worktree", target, maxBytes: 1024, maxFiles: 10 }],
      };
      expect(() => parseTemplateManifest(manifest)).toThrow();
    }

    const overlap = baseManifest();
    const overlapSpec = overlap.spec as Record<string, unknown>;
    overlapSpec.security = { writableMemoryPaths: ["/workspace"] };
    overlapSpec.persistence = {
      mounts: [
        {
          name: "worktree",
          target: "/workspace/repo",
          maxBytes: 1024,
          maxFiles: 10,
        },
      ],
    };
    expect(() => parseTemplateManifest(overlap)).toThrow();

    const source = baseManifest();
    (source.spec as Record<string, unknown>).source = {
      kind: "git",
      destinationMount: "missing",
      repositories: { repo: { url: "https://example.com/repo.git" } },
    };
    expect(() => parseTemplateManifest(source)).toThrow();
  });

  test("findRoute matches exactly and only declared routes", () => {
    const snapshot = snapshotOf(parseTemplateManifest(baseManifest()));
    expect(findRoute(snapshot, "agent", "GET", "/status")).not.toBeNull();
    expect(findRoute(snapshot, "agent", "DELETE", "/status")).toBeNull();
    expect(findRoute(snapshot, "agent", "GET", "/statusx")).toBeNull();
    expect(findRoute(snapshot, "other", "GET", "/status")).toBeNull();
  });
});

describe("AgentAPI transport", () => {
  test("passes an explicit terminal width only to PTY transport", () => {
    const manifest = nativeManifest();
    (manifest.spec as { agent: Record<string, unknown> }).agent.termWidth = 200;
    const spec = parseTemplateManifest(manifest).manifest.spec;

    expect(agentApiHarness(spec).command).toEqual([
      "/usr/local/bin/agentapi",
      "server",
      "--type",
      "codex",
      "--term-width",
      "200",
      "--port",
      "3284",
      "--",
      "codex",
      "--full-auto",
    ]);
  });

  test("rejects invalid terminal widths and ACP width settings", () => {
    for (const termWidth of [9, 65_536, 20.5]) {
      const manifest = nativeManifest();
      (manifest.spec as { agent: Record<string, unknown> }).agent.termWidth = termWidth;
      expect(() => parseTemplateManifest(manifest)).toThrow();
    }

    const acp = nativeManifest();
    (acp.spec as { agent: Record<string, unknown> }).agent = {
      type: "opencode",
      transport: "acp",
      termWidth: 200,
      command: ["opencode", "acp"],
    };
    expect(() => parseTemplateManifest(acp)).toThrow("termWidth is only valid for PTY transport");
  });

  test("derives ACP transport for a native coding agent", () => {
    const manifest = nativeManifest();
    (manifest.spec as { agent: Record<string, unknown> }).agent = {
      type: "opencode",
      transport: "acp",
      command: ["opencode", "acp"],
      cwd: "/workspace",
    };
    const spec = parseTemplateManifest(manifest).manifest.spec;

    expect(agentApiHarness(spec).command).toEqual([
      "/usr/local/bin/agentapi",
      "server",
      "--type",
      "opencode",
      "--experimental-acp",
      "--port",
      "3284",
      "--",
      "opencode",
      "acp",
    ]);
  });
});
