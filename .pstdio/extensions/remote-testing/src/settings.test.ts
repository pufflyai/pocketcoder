import { expect, test } from "bun:test";
import { readSettings } from "./settings";

test("keeps host object settings for qualification template selection", () => {
  const templates = { "linux-x64": { name: "prompt-studio-review", version: "2.0.0" } };
  const { settings } = readSettings({ qualificationTemplates: templates });
  expect(settings.qualificationTemplates).toEqual(templates);
});
