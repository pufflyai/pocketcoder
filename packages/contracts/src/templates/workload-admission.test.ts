import { expect, test } from "bun:test";
import { workloadAdmission } from "./workload-admission";
import { fixtureLimits, installedFixture, workloadFixture } from "./workload-fixtures.test";
import { parseWorkloadTemplate } from "./workload-template";

const bounds = {
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  incarnationId: "container-observed-identity",
  storageProfiles: ["controller-readonly/v1"],
  now: "2026-10-15T00:00:00Z",
  expiresAt: "2026-10-15T00:10:00Z",
};

function fixture(profile: "finite-process" | "cloud-interactive" = "finite-process") {
  const parsed = parseWorkloadTemplate(workloadFixture(profile));
  const installed = installedFixture(parsed.manifest);
  installed.templateDigest = parsed.digest;
  return { parsed, installed };
}

test("declarations alone never establish installed capability support", () => {
  const { parsed } = fixture();
  expect(workloadAdmission(parsed, { ...bounds, ceilings: fixtureLimits, profiles: ["finite-process"] })).toMatchObject(
    { supported: false, reasons: ["installed runtime evidence is required"] },
  );
});

test("both profiles need pinned observed producer, storage, adapter and deployment support", () => {
  for (const profile of ["finite-process", "cloud-interactive"] as const) {
    const { parsed, installed } = fixture(profile);
    const deployment = { ...bounds, ceilings: fixtureLimits, profiles: [profile], installed };
    expect(workloadAdmission(parsed, deployment)).toMatchObject({ supported: true });
    const main = installed.adapters.main;
    if (!main) throw new Error("missing test adapter");
    main.capabilities = ["workspace-cancel", "unknown-outcome"];
    expect(workloadAdmission(parsed, deployment)).toMatchObject({ supported: false });
  }
});

test("rejects every deployment ceiling violation, unsupported profiles and stale pins", () => {
  const { parsed, installed } = fixture();
  const deployment = { ...bounds, ceilings: fixtureLimits, profiles: ["finite-process"], installed };
  for (const key of Object.keys(fixtureLimits) as (keyof typeof fixtureLimits)[]) {
    expect(
      workloadAdmission(parsed, { ...deployment, ceilings: { ...fixtureLimits, [key]: fixtureLimits[key] - 1 } })
        .supported,
    ).toBe(false);
  }
  expect(workloadAdmission(parsed, { ...deployment, profiles: [] }).supported).toBe(false);
  installed.image = `registry.test/other@sha256:${"b".repeat(64)}`;
  expect(workloadAdmission(parsed, deployment).supported).toBe(false);
});

test("rejects evidence from another workspace/incarnation and deadlines outside finite bounds", () => {
  const { parsed, installed } = fixture();
  const deployment = { ...bounds, ceilings: fixtureLimits, profiles: ["finite-process"], installed };
  for (const change of [
    { workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { incarnationId: "replacement-container" },
    { expiresAt: bounds.now },
    { expiresAt: "2026-10-15T00:10:01Z" },
    { storageProfiles: [] },
    { ceilings: {} },
  ]) {
    expect(workloadAdmission(parsed, { ...deployment, ...change }).supported).toBe(false);
  }
});
