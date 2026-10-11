import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRequestDigest, purgeRequestDigest } from "../purge/intent";
import { accountRepository } from "./account-repository";
import { managerContext } from "./context";
import { purgeErasure } from "./purge-erasure";

test("private purge target projection binds the original request and includes its earlier-empty UUID alias", async () => {
  const context = await managerContext();
  try {
    const accounts = accountRepository(context);
    const requestId = randomUUID();
    const expiry = new Date(Date.now() + 60_000);
    const config = { controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`, runtimeClassName: "pc-runc" };
    const original = await accounts.createAccount(requestId, { name: "private label" }, config, expiry);
    const other = await accounts.createAccount(randomUUID(), { name: "unrelated" }, config, expiry);
    const intent = {
      format: "pocketcoder-account-purge/v1" as const,
      accountId: original.account.id,
      operationId: randomUUID(),
      createRequestDigest: createRequestDigest(requestId),
      purgeRequestDigest: purgeRequestDigest(randomUUID()),
      admittedAt: new Date().toISOString(),
    };
    const { purgeTargets } = await import("./purge-targets");
    await expect(
      purgeTargets(context)({ ...intent, createRequestDigest: createRequestDigest(randomUUID()) }),
    ).rejects.toThrow("create identity differs");
    expect(await purgeTargets(context)(intent)).toEqual([
      { id: original.account.id, namespace: original.account.namespace },
    ]);
    await purgeErasure(context)(intent);
    const alias = await accounts.createAccount(requestId, { name: "earlier empty copy" }, config, expiry);
    expect(alias.account.id).not.toBe(intent.accountId);
    expect(await purgeTargets(context)(intent)).toEqual([{ id: alias.account.id, namespace: alias.account.namespace }]);
    expect((await accounts.listAccounts()).map((row) => row.id)).toContain(other.account.id);
  } finally {
    await context.close();
  }
});
