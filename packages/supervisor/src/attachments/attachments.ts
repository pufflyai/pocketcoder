import type { AgentFrame, AttachmentChunk, AttachmentStart } from "@pstdio/pocketcoder-contracts";

// The workload UID cannot own canonical input bytes or authoritative metadata.
// Old attachment frames fail closed instead of writing into the workload home.
export class AttachmentManager {
  constructor(private readonly send: (type: AgentFrame["type"], payload: unknown) => boolean) {}
  private reject(operationId: string) {
    this.send("attachment_result", {
      operation_id: operationId,
      status: "failed",
      failure_code: "invalid",
      detail: "Inputs must be staged in trusted controller storage.",
    });
    return Promise.resolve();
  }
  handleStart(payload: AttachmentStart) {
    return this.reject(payload.operation_id);
  }
  handleChunk(payload: AttachmentChunk) {
    return this.reject(payload.operation_id);
  }
  handleFinish(payload: { operation_id: string }) {
    return this.reject(payload.operation_id);
  }
  handleAbort(_payload: { operation_id: string; reason: string }) {
    return Promise.resolve();
  }
  handleResolve(payload: { operation_id: string; attachment_ids: string[] }) {
    this.send("attachment_resolved", { operation_id: payload.operation_id, missing_id: payload.attachment_ids[0] });
    return Promise.resolve();
  }
}
