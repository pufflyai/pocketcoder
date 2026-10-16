import { expect, test } from "bun:test";
import { normalizeTemplateSnapshot, parseTemplateManifest, snapshotOf } from "./template";
import { renderWorkloadTemplateManifest } from "./template-render";
import { workloadFixture } from "./workload-fixtures.test";
import { inspectTemplateSnapshot, parseVersionedTemplateManifest } from "./workload-format";
import { parseWorkloadTemplate, workloadSnapshotOf } from "./workload-template";

test("versioned render is stable and pins all deployable content", () => {
  const fixture = workloadFixture();
  const first = renderWorkloadTemplateManifest(fixture);
  expect(first.canonical).toBe(renderWorkloadTemplateManifest(structuredClone(fixture)).canonical);
  expect(first.manifest.spec.version).toMatch(/^1\.0\.0-[a-f0-9]{12}$/);
  for (const change of ["/spec/runtime/digest", "/spec/adapters/main/digest"]) {
    expect(
      renderWorkloadTemplateManifest(fixture, { set: [`${change}="sha256:${"b".repeat(64)}"`] }).manifest.spec.version,
    ).not.toBe(first.manifest.spec.version);
  }
  expect(() => renderWorkloadTemplateManifest(fixture, { set: ['/apiVersion="pocketcoder.dev/v1alpha1"'] })).toThrow();
});

test("old immutable snapshots stay alpha and get an explicit format support result", () => {
  const old = snapshotOf(
    parseTemplateManifest({
      apiVersion: "pocketcoder.dev/v1alpha1",
      kind: "Template",
      metadata: { name: "alpha" },
      spec: {
        version: "1.0.0",
        image: workloadFixture().spec.image,
        harness: { command: ["/bin/true"] },
        resources: { cpu: "1", memory: "1Gi" },
      },
    }),
  );
  const original = structuredClone(old);
  expect(inspectTemplateSnapshot(old, ["pocketcoder.dev/v1alpha1"])).toMatchObject({
    format: "pocketcoder.dev/v1alpha1",
    supported: true,
  });
  expect(inspectTemplateSnapshot(old, ["pocketcoder.dev/v1"])).toMatchObject({
    format: "pocketcoder.dev/v1alpha1",
    supported: false,
  });
  expect(old).toEqual(original);
  expect(() => normalizeTemplateSnapshot({ ...old, format: "future" } as typeof old)).toThrow(
    "unsupported immutable snapshot format",
  );
  const current = workloadSnapshotOf(parseWorkloadTemplate(workloadFixture()));
  expect(inspectTemplateSnapshot(current, ["pocketcoder.dev/v1"])).toMatchObject({ supported: true });
  current.digest = `sha256:${"b".repeat(64)}`;
  expect(inspectTemplateSnapshot(current, ["pocketcoder.dev/v1"])).toMatchObject({ supported: false });
  expect(inspectTemplateSnapshot({ format: "future" }, [])).toMatchObject({ supported: false });
});

test("offline readers distinguish versions and the alpha runtime rejects canonical manifests", () => {
  expect(parseVersionedTemplateManifest(workloadFixture()).manifest.apiVersion).toBe("pocketcoder.dev/v1");
  expect(() => parseTemplateManifest(workloadFixture())).toThrow("unsupported template format");
});
