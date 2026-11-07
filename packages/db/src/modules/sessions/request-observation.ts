import { type ExecutionRecord, managed } from "@pstdio/pocketcoder-contracts";
import { mappedCollection } from "./request-collection";

function terminalOutcome(record: ExecutionRecord, fact: Record<string, unknown>): managed.Request["outcome"] {
  if (record.phase === "canceled") return "canceled";
  if (record.phase === "lost") return "lost";
  if (fact.status === "failed" || fact.status === "canceled" || fact.status === "interrupted" || fact.status === "lost")
    return fact.status;
  if (typeof fact.exitCode === "number" && fact.exitCode !== 0) return "failed";
  if (fact.signal) return "failed";
  if (fact.status === "completed" || fact.exitCode === 0 || fact.outcome === "completed") return "completed";
  return "failed";
}
export function requestObservation(current: managed.Request, record: ExecutionRecord) {
  const fact =
    record.outcome && typeof record.outcome === "object" && !Array.isArray(record.outcome) ? record.outcome : {};
  let state: managed.Request["state"] = "waiting";
  let outcome: managed.Request["outcome"] = null;
  let reasonCode: string | null = null;
  if (record.phase === "unknown" || record.phase === "dispatching") state = "checking_outcome";
  if (record.phase === "running") state = "running";
  if (["terminal", "canceled", "lost"].includes(record.phase)) {
    state = "terminal";
    outcome = terminalOutcome(record, fact);
    if (typeof fact.reasonCode === "string") reasonCode = fact.reasonCode;
    else if (fact.refused) reasonCode = "producer_refused";
    else if (outcome === "failed") reasonCode = "producer_terminal_failure";
  }
  const startedAt =
    typeof fact.startedAt === "string" && Number.isFinite(Date.parse(fact.startedAt)) ? fact.startedAt : null;
  return managed.RequestSchema.parse({
    ...current,
    state,
    outcome,
    reasonCode,
    startedAt: current.startedAt ?? startedAt,
    endedAt: state === "terminal" ? record.settledAt : null,
    finalResponse: typeof fact.finalResponse === "string" ? fact.finalResponse : current.finalResponse,
    collection: record.collection
      ? mappedCollection(current.sessionId, current.requestId, record.collection)
      : current.collection,
  });
}
