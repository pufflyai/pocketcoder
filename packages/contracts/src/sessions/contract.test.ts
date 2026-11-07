import { describe, expect, test } from "bun:test";
import examples from "./fixtures/parent-revision-2.json";
import { managedSchemas } from "./schemas";

const accepts = (name: keyof typeof managedSchemas, value: unknown) => managedSchemas[name].safeParse(value).success;

describe("managed integration revision 1", () => {
  test("accepts every parent revision-2 example", () => {
    for (const [name, value] of Object.entries(examples)) {
      expect(accepts(name as keyof typeof managedSchemas, value), name).toBe(true);
    }
  });
  test("requires all profile scopes and rejects unsafe token values and write timestamps", () => {
    const { budgetScopeIds: _, ...withoutScopes } = examples.ExecutionProfile;
    expect(accepts("ExecutionProfile", withoutScopes)).toBe(false);
    expect(accepts("ExecutionProfile", { ...examples.ExecutionProfile, budgetScopeIds: [] })).toBe(false);
    expect(
      accepts("ExecutionProfile", {
        ...examples.ExecutionProfile,
        budgetScopeIds: [examples.ExecutionProfile.budgetScopeIds[0], examples.ExecutionProfile.budgetScopeIds[0]],
      }),
    ).toBe(false);
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(
        accepts("BudgetPolicyWrite", {
          ...examples.BudgetPolicyWrite,
          limits: { ...examples.BudgetPolicyWrite.limits, inputTokens: value },
        }),
      ).toBe(false);
    }
    expect(accepts("BudgetPolicyWrite", examples.BudgetPolicy)).toBe(false);
  });
  test("rejects invalid Unicode and counts message UTF-8 bytes", () => {
    for (const message of ["\ud800", "\udc00", "a\ud800b", "😀".repeat(65537)]) {
      expect(accepts("RequestInput", { ...examples.RequestInput, message })).toBe(false);
    }
    expect(accepts("RequestInput", { ...examples.RequestInput, message: "😀".repeat(65536) })).toBe(true);
  });
  test("rejects inconsistent resource events", () => {
    const event = examples.RuntimeEvent;
    for (const value of [
      { ...event, sessionId: examples.ExecutionProfile.profileId },
      { ...event, requestId: null },
      { ...event, revision: 2 },
      { ...event, kind: "session.updated" },
      { ...event, kind: "session.updated", data: examples.Session },
    ])
      expect(accepts("RuntimeEvent", value)).toBe(false);
    expect(
      accepts("RuntimeEvent", { ...event, requestId: null, kind: "session.updated", data: examples.Session }),
    ).toBe(true);
  });
  test("requires outcome, cancellation, and cleanup evidence to agree with state", () => {
    expect(accepts("Request", { ...examples.Request, state: "terminal" })).toBe(false);
    expect(accepts("Request", { ...examples.Request, outcome: "completed" })).toBe(false);
    expect(
      accepts("Request", {
        ...examples.Request,
        state: "terminal",
        outcome: "canceled",
        finalResponse: "Retained text",
      }),
    ).toBe(true);
    expect(accepts("CancelReceipt", { ...examples.CancelReceipt, state: "completed" })).toBe(false);
    expect(accepts("CancelReceipt", { ...examples.CancelReceipt, scope: "session" })).toBe(false);
    expect(accepts("CleanupReceipt", { ...examples.CleanupReceipt, state: "proved" })).toBe(false);
  });
});

test("collection distinguishes zero-file success, partial selection and loss", async () => {
  const { default: collections } = await import("./fixtures/collection-v1.json");
  for (const value of Object.values(collections)) expect(accepts("CollectionResult", value)).toBe(true);
  const lost = collections.lostBeforeAnyFile;
  expect(accepts("CollectionResult", { ...lost, errors: [] })).toBe(false);
  expect(accepts("CollectionResult", { ...collections.emptyComplete, errors: ["unexpected"] })).toBe(false);
  expect(accepts("CollectionResult", { ...lost, manifestDigest: null })).toBe(false);
  expect(accepts("CollectionResult", { ...collections.pending, completeness: "complete" })).toBe(false);
  expect(
    accepts("Request", { ...examples.Request, collection: { ...lost, requestId: examples.Session.sessionId } }),
  ).toBe(false);
});
