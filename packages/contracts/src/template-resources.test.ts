import { expect, test } from "bun:test";
import { parseTemplateManifest } from "./index";

test("accepts an optional ephemeral storage resource", () => {
  const parsed = parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "resources" },
    spec: {
      version: "1.0.0",
      image: `registry.test/agent@sha256:${"a".repeat(64)}`,
      harness: { command: ["agent"] },
      resources: { cpu: "2", memory: "2Gi", ephemeralStorage: "10Gi" },
    },
  });

  expect(parsed.manifest.spec.resources).toEqual({
    cpu: "2",
    memory: "2Gi",
    ephemeralStorage: "10Gi",
  });
});
