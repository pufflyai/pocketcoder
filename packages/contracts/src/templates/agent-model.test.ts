import { expect, test } from "bun:test";
import { agentApiHarness, parseTemplateManifest, snapshotOf } from "./template";

function manifest(model?: string) {
  return {
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "agent-model" },
    spec: {
      version: "1.0.0",
      image: `example.test/agent@sha256:${"a".repeat(64)}`,
      agent: { type: "custom", command: ["agent"], ...(model === undefined ? {} : { model }) },
      resources: { cpu: "1", memory: "1Gi" },
    },
  };
}

test("the declared model survives parsing and snapshots without configuring the agent", () => {
  for (const model of ["test-model", "a".repeat(255)]) {
    const parsed = parseTemplateManifest(manifest(model));
    expect(parsed.manifest.spec.agent).toMatchObject({ type: "custom", model });
    expect(snapshotOf(parsed).spec.agent).toMatchObject({ type: "custom", model });
    expect(agentApiHarness(parsed.manifest.spec)).toEqual(
      agentApiHarness(parseTemplateManifest(manifest()).manifest.spec),
    );
    expect(parsed.digest).not.toBe(parseTemplateManifest(manifest()).digest);
  }
});

test("model is optional but rejects empty and overlong labels", () => {
  expect(parseTemplateManifest(manifest()).manifest.spec.agent).not.toHaveProperty("model");
  for (const model of ["", "a".repeat(256)]) {
    expect(() => parseTemplateManifest(manifest(model))).toThrow();
  }
});

test("legacy harness templates still parse without agent metadata", () => {
  const input = manifest();
  const { agent, ...spec } = input.spec;
  const parsed = parseTemplateManifest({ ...input, spec: { ...spec, harness: { command: agent.command } } });
  expect(snapshotOf(parsed).spec.agent).toBeUndefined();
});
