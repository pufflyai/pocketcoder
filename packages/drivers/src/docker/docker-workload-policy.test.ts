import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseWorkloadTemplate as parseFixture, parseWorkloadTemplate } from "@pstdio/pocketcoder-contracts";
import { descriptorSchema, qualifyAdapters } from "./docker-workload-policy";

function fixture() {
  const source = parseFixture(
    JSON.parse(readFileSync(new URL("../../../../examples/workloads/finite-process.json", import.meta.url), "utf8")),
  ).manifest;
  source.spec.profile = "service";
  source.spec.adapters.main = {
    kind: "service",
    digest: `sha256:${"b".repeat(64)}`,
    protocol: "pocketcoder.execution/v1",
    service: "agent",
    env: {},
  };
  source.spec.services = {
    agent: {
      baseUrl: "http://127.0.0.1:3284",
      healthPath: "/status",
      required: true,
      routes: [
        {
          method: "GET",
          path: "/status",
          query: [],
          responseMode: "buffered",
          maxRequestBytes: 1024,
          maxResponseBytes: 1024,
          deadlineSeconds: 1,
        },
      ],
      process: { command: ["bun", "/opt/agent/adapter.js"], env: {} },
    },
  };
  const spec = parseWorkloadTemplate(source).manifest.spec;
  const descriptor = descriptorSchema.parse({
    format: "pocketcoder.image/v1",
    codeRoots: ["/opt"],
    runtime: {
      ...spec.runtime,
      artifact: "/opt/pocketcoder/supervisor.js",
      command: ["bun", "/opt/pocketcoder/supervisor.js"],
      entrypoint: [],
    },
    adapters: {
      main: {
        kind: "service",
        digest: spec.adapters.main?.digest,
        protocol: "pocketcoder.execution/v1",
        artifact: "/opt/agent/adapter.js",
        command: ["bun", "/opt/agent/adapter.js"],
        environment: [],
        capabilities: ["unknown-outcome"],
        baseUrl: "http://127.0.0.1:3284",
        healthPath: "/status",
      },
    },
  });
  return { spec, descriptor };
}

test("installed code roots cover imported modules as well as entry files", () => {
  const { spec, descriptor } = fixture();
  expect(qualifyAdapters(spec, descriptor, []).main?.digest).toBe(descriptor.adapters.main?.digest);
  expect(() => qualifyAdapters(spec, descriptor, [{ Destination: "/opt/agent/dependency" }])).toThrow("code");
  spec.security.writableMemoryPaths.push("/opt/agent/dependency");
  expect(() => qualifyAdapters(spec, descriptor, [])).toThrow("code");
});

test("a pinned entry file cannot qualify another command or transport", () => {
  const { spec, descriptor } = fixture();
  const process = spec.services.agent?.process;
  if (!process) throw new Error("fixture process missing");
  process.command = ["bun", "/tmp/other.js"];
  expect(() => qualifyAdapters(spec, descriptor, [])).toThrow("startup");
});

test.each(["command", "cwd", "environment", "code-root"])(
  "checkpoint writer ownership binds the image hook %s",
  (changed) => {
    const { spec, descriptor } = fixture();
    const command = ["bun", "/opt/agent/adapter.js", "quiesce"];
    spec.lifecycle = parseWorkloadTemplate({
      apiVersion: "pocketcoder.dev/v1",
      kind: "Template",
      metadata: { name: "hook-proof" },
      spec: { ...spec, lifecycle: { checkpointHook: { command } } },
    }).manifest.spec.lifecycle;
    expect(() => qualifyAdapters(spec, descriptor, [])).toThrow("Checkpoint hook");
    descriptor.checkpoint = {
      command,
      artifact: "/opt/agent/adapter.js",
      digest: `sha256:${"b".repeat(64)}`,
      environment: [],
      ownsServiceDescendants: true,
    };
    expect(qualifyAdapters(spec, descriptor, []).main).toBeDefined();
    const hook = spec.lifecycle?.checkpointHook;
    if (!hook) throw new Error("Missing hook");
    if (changed === "command") hook.command = ["bun", "/tmp/untrusted.js"];
    if (changed === "cwd") hook.cwd = "/tmp";
    if (changed === "environment") hook.env.PYTHONPATH = "/tmp";
    if (changed === "code-root") descriptor.checkpoint.artifact = "/tmp/hook.js";
    expect(() => qualifyAdapters(spec, descriptor, [])).toThrow();
  },
);
