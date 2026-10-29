import { expect, test } from "bun:test";
import type { PrincipalRow } from "@pstdio/pocketcoder-runtime-core";
import { managedPrincipalId, parsePrincipalFile } from "./principal-file";
import { planPrincipals } from "./principal-plan";

const file = parsePrincipalFile(
  JSON.stringify({
    principals: [
      { name: "new", scopes: ["workspaces:read"], templates: [] },
      { name: "same", scopes: ["workspaces:read"], templates: ["echo"] },
      { name: "wider", scopes: ["workspaces:read", "workspaces:create"], templates: [] },
      { name: "returning", scopes: ["workspaces:read"], templates: [] },
      { name: "taken", scopes: ["workspaces:read"], templates: [] },
    ],
  }),
);

function row(name: string, scopes: string[], templateNames: string[], extra: Partial<PrincipalRow> = {}): PrincipalRow {
  return {
    id: managedPrincipalId(name),
    name,
    scopes,
    templateNames,
    disabledAt: null,
    createdAt: new Date(),
    ...extra,
  };
}

test("the plan creates, updates, re-enables and disables only managed principals", () => {
  const existing = [
    row("same", ["workspaces:read"], ["echo"]),
    row("wider", ["workspaces:read"], []),
    row("returning", ["workspaces:read"], [], { disabledAt: new Date() }),
    row("taken", ["workspaces:read"], [], { id: crypto.randomUUID() }),
    row("removed", ["workspaces:read"], []),
    row("already-removed", ["workspaces:read"], [], { disabledAt: new Date() }),
    row("hand-made", ["workspaces:read"], [], { id: crypto.randomUUID() }),
  ];
  expect(planPrincipals(file, existing)).toEqual([
    { id: managedPrincipalId("new"), name: "new", action: "create", changes: [] },
    { id: managedPrincipalId("same"), name: "same", action: "unchanged", changes: [] },
    { id: managedPrincipalId("wider"), name: "wider", action: "update", changes: ["scopes"] },
    { id: managedPrincipalId("returning"), name: "returning", action: "update", changes: ["enabled"] },
    { id: managedPrincipalId("taken"), name: "taken", action: "conflict", changes: [] },
    { id: managedPrincipalId("removed"), name: "removed", action: "disable", changes: [] },
  ]);
});

test("restarting with the same file plans no change", () => {
  const existing = file.principals.map((principal) =>
    row(principal.name, [...principal.scopes].sort(), [...principal.templates].sort()),
  );
  expect(planPrincipals(file, existing).every((change) => change.action === "unchanged")).toBe(true);
});
