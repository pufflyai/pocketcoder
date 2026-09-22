import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MachineKeyRow } from "@pstdio/pocketcoder-runtime-contracts";
import type { PreparedStore, StoreContractHarness } from "./store-contract";

export function registerCleanupContract(
  name: string,
  harness: StoreContractHarness,
  prepare: () => Promise<PreparedStore>,
) {
  describe.skipIf(harness.enabled === false)(`${name} cleanup contracts`, () => {
    test("concurrent issuance reconciles one key and revoke-all serializes with all issuance paths", async () => {
      const f = await prepare();
      try {
        const row: MachineKeyRow = {
          ...f.machineKey,
          id: randomUUID(),
          issuanceRequestId: "stable-request",
          issuanceRequestDigest: "request-digest",
        };
        const results = await Promise.all(
          Array.from({ length: 8 }, () => f.store.issueMachineKey({ ...row, id: randomUUID() })),
        );
        expect(new Set(results.map((result) => result.key.id)).size).toBe(1);
        expect(results.filter((result) => result.created)).toHaveLength(1);
        expect(await f.store.issueMachineKey({ ...row, issuanceRequestDigest: "changed" })).toMatchObject({
          created: false,
          conflict: true,
        });
        const keys = await f.store.listMachineKeys(f.principal.id, { limit: 1, requestId: "stable-request" });
        expect(keys).toHaveLength(1);
        const all = await f.store.listMachineKeys(f.principal.id, { limit: 100 });
        expect(all).toHaveLength(2);
        const firstPage = await f.store.listMachineKeys(f.principal.id, { limit: 1 });
        const cursor = firstPage[0]?.id;
        if (!cursor) throw new Error("Missing first page");
        expect(await f.store.listMachineKeys(f.principal.id, { limit: 100, cursor })).toHaveLength(1);
        const race = await Promise.allSettled([
          f.store.issueMachineKey({ ...row, id: randomUUID(), issuanceRequestId: "racing-request" }),
          f.store.revokePrincipalKeys(f.principal.id, new Date()),
        ]);
        expect(race[1]?.status).toBe("fulfilled");
        expect((await f.store.listMachineKeys(f.principal.id, { limit: 100 })).every((key) => key.revokedAt)).toBe(
          true,
        );
        await expect(f.store.insertMachineKey({ ...f.machineKey, id: randomUUID() })).rejects.toMatchObject({
          code: "auth.disabled_principal",
        });
        await expect(
          f.store.issueMachineKey({ ...row, id: randomUUID(), issuanceRequestId: "late" }),
        ).rejects.toMatchObject({ code: "auth.disabled_principal" });
      } finally {
        await f.dispose();
      }
    });

    test("purge admission atomically fences stored content and later lifecycle writes", async () => {
      const f = await prepare();
      try {
        const input = f.workspace();
        await f.store.insertWorkspace(input);
        const at = new Date();
        const operation = {
          id: randomUUID(),
          principalId: f.principal.id,
          kind: "purge" as const,
          state: "pending" as const,
          idempotencyKey: "purge",
          requestDigest: "digest",
          workspaceId: input.id,
          checkpointId: null,
          resultWorkspaceId: null,
          reasonCode: null,
          attemptCount: 0,
          createdAt: at,
          updatedAt: at,
          completedAt: null,
        };
        const content = {
          workspaceId: input.id,
          messageId: "one",
          role: "user" as const,
          content: "synthetic",
          metadata: {},
          occurredAt: at,
          createdAt: at,
        };
        const writes = await Promise.allSettled([
          f.store.appendConversationMessage(content),
          f.store.insertOperation(operation),
        ]);
        expect(writes[1]?.status).toBe("fulfilled");
        await f.store.purgeWorkspaceContent(input.id, at);
        await expect(f.store.appendConversationMessage({ ...content, messageId: "late" })).rejects.toBeDefined();
        await expect(
          f.store.appendOutput({ workspaceId: input.id, seq: 0, name: "late", value: "synthetic", occurredAt: at }),
        ).rejects.toBeDefined();
        await f.store.appendLogs(input.id, [
          { stream: "stdout", content: new TextEncoder().encode("synthetic"), occurredAt: at },
        ]);
        await f.store.appendEvent(input.id, "late", { content: "synthetic" }, at);
        await f.store.updateWorkspace(
          input.id,
          { failureLogTail: "synthetic", outputs: { late: "synthetic" }, health: { late: "synthetic" } },
          at,
        );
        expect(await f.store.readLogs(input.id, 0, 100)).toEqual([]);
        expect(await f.store.listOutputs(input.id)).toEqual([]);
        expect(await f.store.readConversation(input.id, 0, 100)).toEqual([]);
        expect(await f.store.claimDueEvents(at, 100)).toEqual([]);
        expect(await f.store.getWorkspace(input.id)).toMatchObject({ failureLogTail: null, outputs: {}, health: {} });
        await expect(
          f.store.insertOperation({ ...operation, id: randomUUID(), kind: "restore", idempotencyKey: "late-restore" }),
        ).rejects.toMatchObject({ code: "operation.conflict" });
      } finally {
        await f.dispose();
      }
    });
  });
}
