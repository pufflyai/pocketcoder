import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountRepository } from "./account-repository";
import { managerContext } from "./context";

test("only a new durable account insertion admits never-started provisioning history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc94-new-admission-"));
  let context: Awaited<ReturnType<typeof managerContext>> | undefined;
  try {
    context = await managerContext(directory);
    const requestId = randomUUID();
    const input = { name: "finite admission" };
    const plan = {
      controllerImage: `registry.invalid/controller@sha256:${"a".repeat(64)}`,
      runtimeClassName: "pc-runc",
      offNodeBackups: false,
    };
    const expiry = new Date(Date.now() + 60_000);
    const created = await accountRepository(context).createAccount(requestId, input, () => plan, expiry);
    expect(created).toMatchObject({ created: true });
    const prior = await accountRepository(context).createAccount(requestId, input, () => plan, expiry);
    expect(prior).toMatchObject({ created: false });
    expect(prior.account.id).toBe(created.account.id);
    expect(prior.operation.id).toBe(created.operation.id);
    await context.close();
    context = await managerContext(directory);
    const reopened = await accountRepository(context).createAccount(requestId, input, () => plan, expiry);
    expect(reopened).toMatchObject({ created: false });
    expect(reopened.account.id).toBe(created.account.id);
    expect(reopened.operation.id).toBe(created.operation.id);
  } finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
