import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import examples from "./fixtures/parent-revision-2.json";
import { managedPlacement } from "./placement";

test("business credentials require an exclusive physical workspace for each session", () => {
  const principalId = randomUUID();
  const sessionA = randomUUID();
  const sessionB = randomUUID();
  const credentialed = { ...examples.ExecutionProfile, credentialBindingId: randomUUID() };
  const a = managedPlacement(principalId, sessionA, credentialed);
  expect(a.mode).toBe("exclusive");
  expect(a).toEqual(managedPlacement(principalId, sessionA, credentialed));
  expect(a.key).not.toBe(managedPlacement(principalId, sessionB, credentialed).key);
  const shared = { ...credentialed, credentialBindingId: null };
  expect(managedPlacement(principalId, sessionA, shared)).toEqual(managedPlacement(principalId, sessionB, shared));
  expect(managedPlacement(principalId, sessionA, shared).key).not.toBe(
    managedPlacement(randomUUID(), sessionA, shared).key,
  );
  expect(managedPlacement(principalId, sessionA, shared).key).not.toBe(
    managedPlacement(principalId, sessionA, { ...shared, revision: shared.revision + 1 }).key,
  );
});
