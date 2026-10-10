import { expect, test } from "bun:test";
import { parseTemplateManifest } from "../templates/template";
import { DisplaySchema } from "./display";

test("desktop display uses a fixed loopback endpoint and cannot be declared as a preview", () => {
  expect(DisplaySchema.parse({ mode: "desktop" })).toEqual({ mode: "desktop" });
  expect(DisplaySchema.safeParse({ mode: "desktop", port: 6000 }).success).toBe(false);
  const manifest = {
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "desktop" },
    spec: {
      version: "1.0.0",
      image: `test@sha256:${"a".repeat(64)}`,
      harness: { command: ["desktop"] },
      resources: { cpu: "1", memory: "512Mi" },
      display: { mode: "desktop" },
      previews: {} as Record<string, { port: number }>,
    },
  };
  expect(parseTemplateManifest(manifest).manifest.spec.display).toEqual({ mode: "desktop" });
  manifest.spec.previews = { display: { port: 3000 } };
  expect(() => parseTemplateManifest(manifest)).toThrow();
});
