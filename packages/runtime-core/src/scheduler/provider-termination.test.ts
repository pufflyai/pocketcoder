import { expect, test } from "bun:test";
import type { WorkspaceRow } from "../types";
import { stopWorkspaceProvider } from "./provider-termination";

test("provider removal follows durable evidence storage and preserves proof on retry", async () => {
  // Provider and store are explicit IO boundaries; order is the contract here.
  const proof = { job: { uid: "job" }, pods: ["pod"] };
  const state: { saved: Record<string, unknown> | null } = { saved: null };
  let observed: Record<string, unknown> | null = proof;
  const calls: string[] = [];
  const driver = {
    stop: async () => {
      calls.push("stop");
    },
    terminationEvidence: async () => observed,
    remove: async () => {
      expect(state.saved?.terminationEvidence).toEqual(proof);
      calls.push("remove");
    },
  };
  const row: Pick<WorkspaceRow, "id" | "providerKind" | "providerRef"> = {
    id: "workspace",
    providerKind: "kubernetes",
    providerRef: { id: "job", jobUid: "f9c9c081-2d7e-4b26-bba2-aa164d1ac2ae" },
  };
  const store = {
    getWorkspace: async () => ({ ...row, providerRef: state.saved ?? row.providerRef }),
    updateWorkspace: async (_id: string, patch: { providerRef?: Record<string, unknown> | null }) => {
      state.saved = patch.providerRef ?? null;
      calls.push("persist");
    },
  };
  await stopWorkspaceProvider(store, driver, row, 1, new Date());
  expect(calls).toEqual(["stop", "persist", "remove"]);
  observed = null;
  await stopWorkspaceProvider(store, driver, row, 1, new Date());
  expect(state.saved?.terminationEvidence).toEqual(proof);
});

test("failed evidence persistence cannot remove the provider proof", async () => {
  let removed = false;
  const driver = {
    stop: async () => {},
    terminationEvidence: async () => ({ proof: true }),
    remove: async () => {
      removed = true;
    },
  };
  const row: Pick<WorkspaceRow, "id" | "providerKind" | "providerRef"> = {
    id: "workspace",
    providerKind: "kubernetes",
    providerRef: { id: "job", jobUid: "f9c9c081-2d7e-4b26-bba2-aa164d1ac2ae" },
  };
  const store = {
    getWorkspace: async () => row,
    updateWorkspace: async () => {
      throw new Error("database unavailable");
    },
  };
  await expect(stopWorkspaceProvider(store, driver, row, 1, new Date())).rejects.toThrow("database unavailable");
  expect(removed).toBe(false);
});
