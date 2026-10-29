import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WorkspaceOperationRow } from "@pstdio/pocketcoder-runtime-contracts";
import { createTestStoreFactory, sqlStateOf } from "../../test-fixtures";

const createStore = createTestStoreFactory();

function operation(principalId: string): WorkspaceOperationRow {
  const now = new Date();
  return {
    id: randomUUID(),
    principalId,
    kind: "restore",
    state: "pending",
    idempotencyKey: randomUUID(),
    requestDigest: randomUUID(),
    workspaceId: null,
    checkpointId: null,
    resultWorkspaceId: randomUUID(),
    reasonCode: null,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

test("rejects operation references to a missing result workspace", async () => {
  const store = await createStore();
  const principal = await store.createPrincipal("fk-test", ["admin"], ["*"]);
  const error = await store.insertOperation(operation(principal.id)).catch((caught) => caught);
  expect(sqlStateOf(error)).toBe("23503");
  expect(error.cause).toMatchObject({ constraint: "workspace_operations_result_workspace_id_workspaces_id_fkey" });
});
