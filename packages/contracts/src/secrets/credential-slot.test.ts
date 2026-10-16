import { expect, test } from "bun:test";
import { CredentialSlotSchema } from "./credential-slot";

test("slots reference trusted policy versions and cannot carry standing credentials", () => {
  const slot = {
    policyRef: "fixture",
    policyVersion: "1",
    binding: "post-create-grant",
    delivery: "workspace-expiring-file",
    maxLeaseSeconds: 600,
  };
  expect(CredentialSlotSchema.safeParse(slot).success).toBe(true);
  expect(CredentialSlotSchema.safeParse({ ...slot, token: "standing-secret" }).success).toBe(false);
  expect(CredentialSlotSchema.safeParse({ ...slot, delivery: "environment-literal" }).success).toBe(false);
});
