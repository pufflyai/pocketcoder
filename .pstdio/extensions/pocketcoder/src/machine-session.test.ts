import { expect, test } from "bun:test";
import { sessionBrowser } from "@pstdio/sdk/extensions";
import { machineSessionTarget } from "./machine-session";

test("connecting a machine pins its session beside the current Lab page", () => {
  const target = machineSessionTarget("project", { id: "session", title: "Onefin" });
  expect(target.kind).toBe("panel");
  expect(target.panel).toEqual(sessionBrowser.panels.conversation);
  expect(target.open).toBe("pin");
  expect(target.resource).toEqual({
    type: "session",
    extensionId: "pstdio",
    projectId: "project",
    id: "session",
    label: "Onefin",
  });
});
