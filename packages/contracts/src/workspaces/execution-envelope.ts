import type { ConversationRequestIdentity } from "../conversations/identity";
import { executionInputManifestId } from "./execution-dispatch";
import type { WorkloadAcceptance } from "./workload-operation";

export const INPUT_PROJECTION_TARGET = "/run/pocketcoder/inputs";

export function inputProjectionDirectory(manifestId: string) {
  return `${INPUT_PROJECTION_TARGET}/${manifestId}`;
}

export function executionAcceptEnvelope(
  acceptance: WorkloadAcceptance,
  conversationIdentity: ConversationRequestIdentity | null,
  inputDirectory?: string,
) {
  // Publishers use this fixed workload path, so admission can size it before pinning files.
  const directory =
    inputDirectory ??
    (acceptance.inputs.objects.length ? inputProjectionDirectory(executionInputManifestId(acceptance)) : undefined);
  return { acceptance, conversationIdentity, ...(directory ? { inputDirectory: directory } : {}) };
}

export function executionLookupEnvelope(execution: WorkloadAcceptance["execution"]) {
  return { execution };
}

export function executionAckEnvelope(acceptance: WorkloadAcceptance) {
  return { execution: acceptance.execution, fingerprint: acceptance.fingerprint };
}

export function executionCancelEnvelope(acceptance: WorkloadAcceptance, cancelId: string) {
  return { execution: acceptance.execution, cancelId, fingerprint: acceptance.fingerprint, scope: "operation" };
}
