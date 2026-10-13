import { expect, test } from "bun:test";
import { launchInput, projectWorkspace, remoteRef } from "./workspace";

const context = (): Record<string, unknown> => ({});

test("uses one configured immutable template and accepts only source input", async () => {
  const ctx = context();
  ctx.templateName = "pstdio-workspace";
  ctx.templateVersion = "1.2.0";
  expect(await launchInput(ctx, { repository: "app", revision: "main" })).toEqual({
    template: { name: "pstdio-workspace", version: "1.2.0" },
    source: { kind: "git", repository: "app", revision: "main" },
  });
  for (const key of ["template", "templateVersion", "instance", "command"])
    await expect(launchInput(ctx, { [key]: "override" })).rejects.toThrow("Unsupported workspace parameter");
});

test("requires a pinned configuration and complete source selection", async () => {
  const ctx = context();
  await expect(launchInput(ctx, {})).rejects.toThrow("template");
  ctx.templateName = "pstdio-workspace";
  await expect(launchInput(ctx, {})).rejects.toThrow("version");
  ctx.templateVersion = "1.0.0";
  expect(await launchInput(ctx, {})).toEqual({ template: { name: "pstdio-workspace", version: "1.0.0" } });
  expect(await launchInput(ctx, { repository: "", revision: "" })).toEqual({
    template: { name: "pstdio-workspace", version: "1.0.0" },
  });
  for (const params of [{ repository: "app" }, { revision: "main" }, { repository: 2, revision: "main" }])
    await expect(launchInput(ctx, params)).rejects.toThrow();
});

test("projects an independent remote target and rejects Lab references", () => {
  const result = projectWorkspace("pocketcoder.pocketcoder-workspaces", {
    id: "remote-id",
    external_id: "host-id",
    state: "ready",
    agent_state: "stable",
    change_cursor: 1,
    reason_code: null,
    failure: null,
  });
  expect(result.executionTarget).toEqual({
    kind: "remote",
    providerId: "pocketcoder.pocketcoder-workspaces.workspace-type.remote",
    providerRef: result.providerRef,
  });
  expect(remoteRef(result.providerRef)).toEqual({ remoteId: "remote-id", workspaceId: "host-id" });
  expect(() => remoteRef({ version: 1, data: { instanceId: "lab", machineId: "machine" } })).toThrow("reference");
  expect(result.capabilities.files).toBe("none");
});
