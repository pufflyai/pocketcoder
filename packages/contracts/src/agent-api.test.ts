import { describe, expect, test } from "bun:test";
import { agentApiHarness, parseTemplateManifest } from "./index";

const DIGEST = "a".repeat(64);

function nativeManifest(): Record<string, unknown> {
  return {
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "fixture", description: "test" },
    spec: {
      version: "1.0.0",
      image: `registry.test/agent@sha256:${DIGEST}`,
      agent: {
        type: "codex",
        command: ["codex", "--full-auto"],
        cwd: "/workspace",
        env: { CODEX_HOME: "/state/codex" },
      },
      resources: { cpu: "2", memory: "2Gi" },
    },
  };
}

function nativeRestoreManifest(stateFile?: string): Record<string, unknown> {
  const manifest = nativeManifest();
  const spec = manifest.spec as {
    agent: Record<string, unknown>;
    persistence?: Record<string, unknown>;
  };
  if (stateFile !== undefined) spec.agent.stateFile = stateFile;
  spec.persistence = {
    mounts: [
      { name: "worktree", target: "/workspace", maxBytes: 1024, maxFiles: 10 },
      { name: "agent-state", target: "/state", maxBytes: 1024, maxFiles: 10 },
    ],
    conversationRestore: "supported",
    sessionCompatibility: "agentapi-0.12",
  };
  return manifest;
}

describe("AgentAPI transport", () => {
  test("passes a persisted state file to AgentAPI", () => {
    const spec = parseTemplateManifest(nativeRestoreManifest("/state/agentapi.json")).manifest.spec;

    expect(agentApiHarness(spec).command).toEqual([
      "/usr/local/bin/agentapi",
      "server",
      "--type",
      "codex",
      "--state-file",
      "/state/agentapi.json",
      "--port",
      "3284",
      "--",
      "codex",
      "--full-auto",
    ]);
  });

  test("requires a persisted state file for native conversation restore", () => {
    for (const stateFile of [undefined, "/tmp/agentapi.json"]) {
      expect(() => parseTemplateManifest(nativeRestoreManifest(stateFile))).toThrow(
        "supported conversation restore requires agent.stateFile below a persistence mount",
      );
    }
  });

  test("requires the state file to be below a persistence mount", () => {
    expect(() => parseTemplateManifest(nativeRestoreManifest("/state"))).toThrow(
      "supported conversation restore requires agent.stateFile below a persistence mount",
    );
  });

  test("rejects AgentAPI state persistence for ACP transport", () => {
    const stateFile = nativeManifest();
    (stateFile.spec as { agent: Record<string, unknown> }).agent = {
      type: "opencode",
      transport: "acp",
      command: ["opencode", "acp"],
      stateFile: "/state/agentapi.json",
    };
    expect(() => parseTemplateManifest(stateFile)).toThrow(
      "stateFile is only valid for PTY transport",
    );

    const restore = nativeRestoreManifest();
    (restore.spec as { agent: Record<string, unknown> }).agent = {
      type: "opencode",
      transport: "acp",
      command: ["opencode", "acp"],
    };
    expect(() => parseTemplateManifest(restore)).toThrow(
      "supported conversation restore requires PTY transport",
    );
  });

  test("rejects an unnormalized AgentAPI state file", () => {
    const manifest = nativeManifest();
    (manifest.spec as { agent: Record<string, unknown> }).agent.stateFile =
      "/state/../tmp/agentapi.json";

    expect(() => parseTemplateManifest(manifest)).toThrow(
      "stateFile must be a normalized absolute filesystem path",
    );
  });

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
