import { expect, test } from "bun:test";
import { parseCatalogTemplate } from "./template-catalog";

test("the catalog accepts current workload templates for file-aware agents", () => {
  const template = {
    apiVersion: "pocketcoder.dev/v1",
    kind: "Template",
    metadata: { name: "file-agent" },
    spec: { version: "1.0.0" },
  };
  expect(parseCatalogTemplate("file-agent.json", JSON.stringify(template))).toMatchObject({
    name: "file-agent",
    version: "1.0.0",
  });
});
