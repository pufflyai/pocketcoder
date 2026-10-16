import {
  type ConversationRequestIdentity,
  type ExecutionRecord,
  type WorkloadAcceptance,
  WorkloadAcceptanceSchema,
} from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import {
  insertConversationExecution,
  validateConversationExecution,
  validateExecutionReplay,
} from "../conversations/execution-acceptance";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { requireExecutionPrincipal } from "./execution-authority";
import { pinExecutionInputs } from "./execution-inputs";
import { readExecution } from "./execution-owners";
import { executionConflict, validateExecution } from "./execution-validation";

export function acceptExecution(context: DatabaseContext) {
  const {
    db,
    tables: { workspaces },
  } = context;
  return async (input: WorkloadAcceptance, at: Date, identity?: ConversationRequestIdentity) => {
    input = WorkloadAcceptanceSchema.parse(input);
    return db.transaction(async (tx) => {
      await lockStorageCapacity(context, tx);
      const workspace = requiredRow(
        (await tx.select().from(workspaces).where(eq(workspaces.id, input.execution.workspaceId)).for("update"))[0],
      );
      const previous = await readExecution(context, tx, workspace, input.execution);
      if (previous) {
        validateExecutionReplay(previous, input, identity);
        return { kind: "replayed" as const, record: previous };
      }
      await requireExecutionPrincipal(context, tx, input.callerPrincipalId);
      validateExecution(workspace, input, at);
      if (input.execution.owner === "process" && (workspace.processExecution || workspace.finiteProcess || identity))
        executionConflict("Finite process already accepted or conversation identity supplied.");
      if (input.execution.owner === "conversation-request")
        identity = await validateConversationExecution(context, tx, input, identity);
      await pinExecutionInputs(context, tx, input, at);
      const record: ExecutionRecord = {
        acceptance: input,
        conversationIdentity: identity ?? null,
        outcome: null,
        acceptedAt: at.toISOString(),
        dispatchClaimedAt: null,
        phase: "accepted",
        cancel: null,
        settledAt: null,
        acknowledgedAt: null,
        finalizedAt: null,
      };
      if (input.execution.owner === "process")
        await tx.update(workspaces).set({ processExecution: record }).where(eq(workspaces.id, workspace.id));
      else await insertConversationExecution(context, tx, record, requiredRow(identity));
      return { kind: "accepted" as const, record };
    });
  };
}
