import { readPrivateFile } from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import { backupWindow } from "./backup-window";

const Accounts = z.object({ items: z.array(z.object({ id: z.uuid(), state: z.string() })) });
const Operation = z.object({ id: z.uuid(), state: z.string() });
const Inventory = z.object({ items: z.array(z.object({ id: z.uuid() })) });

export async function backupAccounts(input: { managerUrl: string; tokenFile: string; timeoutMs?: number }) {
  const token = (await readPrivateFile(input.tokenFile, 4096)).toString().trim();
  const requestId = `scheduled/${backupWindow()}`;
  const timeout = input.timeoutMs ?? 15 * 60_000;
  async function request(path: string, method = "GET") {
    const response = await fetch(new URL(path, input.managerUrl), {
      method,
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": requestId },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Backup request failed: HTTP ${response.status}`);
    return response.json();
  }
  const accounts = Accounts.parse(await request("/v1/accounts")).items;
  const completed: string[] = [];
  const unavailable: string[] = [];
  const failures: unknown[] = [];
  const captures: { path: string; id: string }[] = [];
  for (const account of accounts) {
    if (account.state !== "ready") {
      unavailable.push(account.id);
      continue;
    }
    try {
      const path = `/v1/accounts/${account.id}/backups`;
      const { operation } = z.object({ operation: Operation }).parse(await request(path, "POST"));
      captures.push({ path, id: operation.id });
    } catch (error) {
      failures.push(error);
    }
  }
  // Admit every healthy peer before a slow capture consumes the polling window.
  const deadline = Date.now() + timeout;
  for (const capture of captures) {
    try {
      for (;;) {
        const current = Operation.parse(await request(`/v1/operations/${capture.id}`));
        if (current.state === "succeeded") break;
        if (Date.now() >= deadline) throw new Error(`Backup remains pending: ${capture.id}`);
        await Bun.sleep(Math.min(1000, deadline - Date.now()));
      }
      if (!Inventory.parse(await request(capture.path)).items.some(({ id }) => id === capture.id))
        throw new Error(`Backup receipt is missing: ${capture.id}`);
      completed.push(capture.id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Account backup cycle failed");
  return { requestId, completed, unavailable };
}
