import type { PrincipalRow } from "@pstdio/pocketcoder-runtime-core";
import { type ManagedPrincipal, managedPrincipalId, type PrincipalFile } from "./principal-file";

export interface PrincipalChange {
  id: string;
  name: string;
  action: "create" | "update" | "unchanged" | "disable" | "conflict";
  changes: string[];
}

const sorted = (values: string[]) => [...new Set(values)].sort();
const same = (left: string[], right: string[]) => sorted(left).join("\n") === sorted(right).join("\n");

export function desiredGrants(principal: ManagedPrincipal) {
  return { scopes: sorted(principal.scopes), templateNames: sorted(principal.templates) };
}

function planDeclared(principal: ManagedPrincipal, existing: PrincipalRow | undefined): PrincipalChange {
  const id = managedPrincipalId(principal.name);
  const change = { id, name: principal.name, changes: [] as string[] };
  if (!existing) return { ...change, action: "create" };
  // A principal someone created by hand keeps its random ID; the file must not take it over.
  if (existing.id !== id) return { ...change, action: "conflict" };
  if (!same(existing.scopes, principal.scopes)) change.changes.push("scopes");
  if (!same(existing.templateNames, principal.templates)) change.changes.push("templates");
  if (existing.disabledAt) change.changes.push("enabled");
  return { ...change, action: change.changes.length ? "update" : "unchanged" };
}

// Only principals whose ID derives from their name are managed. Others are never touched.
export function planPrincipals(file: PrincipalFile, existing: PrincipalRow[]) {
  const byName = new Map(existing.map((row) => [row.name, row]));
  const declared = new Set(file.principals.map((principal) => principal.name));
  const removed = existing
    .filter((row) => !declared.has(row.name) && !row.disabledAt && row.id === managedPrincipalId(row.name))
    .map((row): PrincipalChange => ({ id: row.id, name: row.name, action: "disable", changes: [] }));
  return [...file.principals.map((principal) => planDeclared(principal, byName.get(principal.name))), ...removed];
}
