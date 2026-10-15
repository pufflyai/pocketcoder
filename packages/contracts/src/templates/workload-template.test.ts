import { expect, test } from "bun:test";
import { workloadFixture } from "./workload-fixtures.test";
import { parseWorkloadTemplate } from "./workload-template";

test("one versioned contract accepts both minimum profiles and arbitrary credential-free commands", () => {
  for (const profile of ["finite-process", "cloud-interactive"] as const) {
    const parsed = parseWorkloadTemplate(workloadFixture(profile));
    expect(parsed.manifest.apiVersion).toBe("pocketcoder.dev/v1");
    expect(parsed.manifest.spec.credentialSlots).toEqual({});
    expect(parsed.manifest.spec.adapters.main?.command).toBeDefined();
    expect(parsed.manifest.spec).not.toHaveProperty("agent");
    expect(parsed.manifest.spec).not.toHaveProperty("harness");
  }
});

test("requires every finite limit and rejects incompatible profile declarations", () => {
  const fixture = workloadFixture();
  for (const key of Object.keys(fixture.spec.limits)) {
    const missing = structuredClone(fixture);
    Reflect.deleteProperty(missing.spec.limits, key);
    expect(() => parseWorkloadTemplate(missing)).toThrow(key);
  }
  for (const value of [0, -1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = workloadFixture();
    invalid.spec.limits.deadlineSeconds = value;
    expect(() => parseWorkloadTemplate(invalid)).toThrow();
  }
  const wrong = workloadFixture("cloud-interactive");
  wrong.spec.adapters.main.kind = "process";
  expect(() => parseWorkloadTemplate(wrong)).toThrow("cloud-interactive");
});

test("generic service transport needs no agent or execution adapter", () => {
  const fixture = workloadFixture();
  const spec: Record<string, unknown> = fixture.spec;
  spec.profile = "service";
  spec.adapters = {};
  spec.operations = {};
  spec.services = {
    api: {
      baseUrl: "http://127.0.0.1:8080",
      process: { command: ["bun", "serve.ts"] },
      routes: [{ method: "POST", path: "/work" }],
    },
  };
  const parsed = parseWorkloadTemplate(fixture);
  expect(parsed.manifest.spec.adapters).toEqual({});
  expect(parsed.manifest.spec.operations).toEqual({});
  expect(parsed.manifest.spec.services.api?.process?.command).toEqual(["bun", "serve.ts"]);
});

test("optional AgentAPI and service adapters compose with the same operation schema", () => {
  for (const kind of ["agentapi", "service"] as const) {
    const fixture = workloadFixture("cloud-interactive");
    const adapter: Record<string, unknown> = fixture.spec.adapters.main;
    adapter.kind = kind;
    if (kind === "service") {
      delete adapter.command;
      adapter.service = "api";
      fixture.spec.services = {
        api: { baseUrl: "http://127.0.0.1:8080", routes: [{ method: "POST", path: "/work" }] },
      };
    }
    expect(parseWorkloadTemplate(fixture).manifest.spec.adapters.main?.kind).toBe(kind);
  }
});

test("rejects undeclared slots, literal secrets, protected paths, unpinned and mixed formats", () => {
  for (const env of [{ API_TOKEN: "literal" }, { API_TOKEN: "credentialSlot:missing" }, { OTHER: "secretRef:old" }]) {
    const fixture = workloadFixture();
    const adapter: Record<string, unknown> = fixture.spec.adapters.main;
    adapter.env = env;
    expect(() => parseWorkloadTemplate(fixture)).toThrow();
  }
  for (const root of ["/", "/run/pocketcoder/secrets", "/outputs/../etc", "/proc/state"]) {
    const fixture = workloadFixture();
    fixture.spec.operations.run.outputRoots = [root];
    expect(() => parseWorkloadTemplate(fixture)).toThrow();
  }
  const mixed = workloadFixture();
  Reflect.set(mixed.spec, "agent", { command: ["pi"] });
  expect(() => parseWorkloadTemplate(mixed)).toThrow();
  const unpinned = workloadFixture();
  unpinned.spec.adapters.main.digest = "latest";
  expect(() => parseWorkloadTemplate(unpinned)).toThrow();
});
