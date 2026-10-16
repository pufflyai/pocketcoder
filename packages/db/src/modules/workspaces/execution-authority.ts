import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { executionConflict } from "./execution-validation";

export async function requireExecutionPrincipal(context: DatabaseContext, tx: Transaction, principalId: string) {
  const principals = context.tables.principals;
  const [principal] = await tx.select().from(principals).where(eq(principals.id, principalId));
  if (!principal || principal.disabledAt) executionConflict("Execution principal is disabled or missing.");
}
