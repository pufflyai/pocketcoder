import {
  canonicalJson,
  type ExecutionPhase,
  type ExecutionRecord,
  executionSettled,
  type FiniteProcessFact,
} from "@pstdio/pocketcoder-contracts";

export function acceptsProcessFact(record: ExecutionRecord | null, fact: FiniteProcessFact) {
  if (!record) return false;
  if (
    !record.dispatchClaimedAt ||
    record.acceptance.fingerprint !== fact.fingerprint ||
    canonicalJson(record.acceptance.execution) !== canonicalJson(fact.execution)
  )
    return false;
  if (executionSettled(record)) {
    const compatible =
      (record.phase === "terminal" && fact.phase === "exited") || (record.phase === "lost" && fact.phase === "lost");
    return compatible && canonicalJson(record.outcome) === canonicalJson(fact);
  }
  return true;
}
export function observedProcessExecution(record: ExecutionRecord | null, fact: FiniteProcessFact) {
  if (!record) return null;
  let phase: ExecutionPhase = "dispatching";
  if (fact.phase === "running") phase = "running";
  if (fact.phase === "exited") phase = "terminal";
  if (fact.phase === "lost") phase = "lost";
  const terminal = phase === "terminal" || phase === "lost";
  return { ...record, phase, outcome: fact, settledAt: terminal ? (record.settledAt ?? fact.endedAt) : null };
}
