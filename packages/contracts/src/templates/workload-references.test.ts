import { expect, test } from "bun:test";
import { workloadAdmission } from "./workload-admission";
import { fixtureLimits, installedFixture, workloadFixture } from "./workload-fixtures.test";
import { parseWorkloadTemplate } from "./workload-template";

function deployment(parsed: ReturnType<typeof parseWorkloadTemplate>) {
  const installed = installedFixture(parsed.manifest);
  installed.templateDigest = parsed.digest;
  return {
    workspaceId: installed.workspaceId,
    incarnationId: installed.incarnationId,
    profiles: [parsed.manifest.spec.profile],
    storageProfiles: [installed.storage.profile],
    ceilings: fixtureLimits,
    now: "2026-10-15T00:00:00Z",
    expiresAt: "2026-10-15T00:10:00Z",
    installed,
  };
}

function constructorFixture() {
  const fixture = workloadFixture("cloud-interactive");
  return {
    ...fixture,
    spec: {
      ...fixture.spec,
      adapters: { constructor: fixture.spec.adapters.main },
      operations: { run: { ...fixture.spec.operations.run, adapter: "constructor" } },
    },
  };
}

test("operations reject inherited adapter names that have no declaration", () => {
  const fixture = workloadFixture("cloud-interactive");
  fixture.spec.operations.run.adapter = "constructor";
  expect(() => parseWorkloadTemplate(fixture)).toThrow("operation must name a pinned adapter");
});

test("service adapters reject inherited service names that have no declaration", () => {
  const fixture = workloadFixture("cloud-interactive");
  const adapter: Record<string, unknown> = fixture.spec.adapters.main;
  adapter.kind = "service";
  delete adapter.command;
  adapter.service = "constructor";
  expect(() => parseWorkloadTemplate(fixture)).toThrow("service adapters require a declared service");
});

test("environment references reject inherited credential slots that have no declaration", () => {
  const fixture = workloadFixture();
  Reflect.set(fixture.spec.adapters.main, "env", { API_TOKEN: "credentialSlot:constructor" });
  expect(() => parseWorkloadTemplate(fixture)).toThrow("unknown credential slot");
});

test("admission returns unsupported when a declared constructor adapter is not installed", () => {
  const parsed = parseWorkloadTemplate(constructorFixture());
  const evidence = deployment(parsed);
  expect(workloadAdmission(parsed, evidence)).toMatchObject({ supported: true });
  Reflect.deleteProperty(evidence.installed.adapters, "constructor");
  expect(workloadAdmission(parsed, evidence)).toMatchObject({
    supported: false,
    reasons: ["installed adapter pin does not match: constructor"],
  });
});

test("constructor remains a legal explicit adapter, service and credential-slot name", () => {
  const fixture = constructorFixture();
  fixture.spec.services = {
    constructor: { baseUrl: "http://127.0.0.1:8080", routes: [{ method: "POST", path: "/work" }] },
  };
  fixture.spec.credentialSlots = {
    constructor: {
      policyRef: "fixture",
      policyVersion: "1",
      binding: "fixed-scope",
      delivery: "workspace-expiring-file",
      maxLeaseSeconds: 600,
    },
  };
  const adapter: Record<string, unknown> = fixture.spec.adapters.constructor;
  adapter.kind = "service";
  delete adapter.command;
  adapter.service = "constructor";
  adapter.env = { API_TOKEN: "credentialSlot:constructor" };
  const parsed = parseWorkloadTemplate(fixture);
  expect(Object.hasOwn(parsed.manifest.spec.adapters, "constructor")).toBe(true);
  expect(Object.hasOwn(parsed.manifest.spec.services, "constructor")).toBe(true);
  expect(Object.hasOwn(parsed.manifest.spec.credentialSlots, "constructor")).toBe(true);
  expect(workloadAdmission(parsed, deployment(parsed))).toMatchObject({ supported: true });
});
