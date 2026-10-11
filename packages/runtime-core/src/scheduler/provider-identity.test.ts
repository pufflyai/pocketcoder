import { expect, test } from "bun:test";
import { sameProvider } from "./provider-termination";

test("same-name Jobs from different admissions cannot share termination proof", () => {
  const workspace = {
    id: "workspace",
    providerKind: "kubernetes",
    providerRef: {
      kind: "kubernetes",
      id: "pool-job",
      namespace: "account",
      poolRuntimeId: "warm",
      jobUid: "original",
    },
  };
  expect(
    sameProvider(workspace, { ...workspace, providerRef: { ...workspace.providerRef, jobUid: "replacement" } }),
  ).toBe(false);
  expect(sameProvider(workspace, { ...workspace, providerRef: { ...workspace.providerRef } })).toBe(true);
  const { jobUid: _uid, ...nameOnly } = workspace.providerRef;
  expect(sameProvider({ ...workspace, providerRef: nameOnly }, { ...workspace, providerRef: nameOnly })).toBe(false);
});

test("Secret-only proof matches only the same never-admitted launch receipt", () => {
  const ref = {
    kind: "kubernetes",
    id: "prepared-job",
    namespace: "account",
    terminationEvidence: {
      neverAdmitted: { inputUid: "input-uid", workspaceId: "workspace", templateDigest: "sha256:template" },
    },
  };
  const current = { id: "workspace", providerKind: "kubernetes", providerRef: ref };
  expect(sameProvider(current, current)).toBe(true);
  expect(
    sameProvider(current, {
      ...current,
      providerRef: {
        ...ref,
        terminationEvidence: {
          neverAdmitted: { ...ref.terminationEvidence.neverAdmitted, inputUid: "replacement" },
        },
      },
    }),
  ).toBe(false);
});
