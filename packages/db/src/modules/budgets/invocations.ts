import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { ManagedInvocationIdentity, OpenInvocation } from "@pstdio/pocketcoder-runtime-contracts";
import { type DatabaseContext, lock } from "../../database/context";
import { budgetLedger } from "./ledger";

export function invocationObserver(context: DatabaseContext, now: () => Date) {
  const ledger = budgetLedger(context, now);
  return {
    async openInvocations(): Promise<OpenInvocation[]> {
      const records = await context.db.transaction((tx) => ledger.records(tx));
      return records.flatMap((record) =>
        record.state === "reserved" || record.state === "send_claimed"
          ? [{ identity: record.reservation.identity, state: record.state }]
          : [],
      );
    },
    // A provider response ID is the only handle for later retrieval of usage. It is kept before the
    // response finishes, so a crash during streaming still leaves evidence for audited reconciliation.
    async observeResponse(identity: ManagedInvocationIdentity, responseId: string) {
      if (!responseId || responseId.length > 1024)
        throw new ApiError("validation.invalid", "A provider response identity is required.");
      await context.db.transaction(async (tx) => {
        await ledger.required(tx, identity);
        await lock(tx, identity.invocationId, 35);
        const record = await ledger.required(tx, identity);
        if (record.state === "reserved" || record.state === "abandoned")
          throw new ApiError("budget.conflict", "A response requires a claimed invocation.");
        if (record.responseId === responseId) return;
        if (record.responseId) throw new ApiError("budget.conflict", "The provider response identity changed.");
        await ledger.write(tx, { ...record, responseId });
      });
    },
  };
}
