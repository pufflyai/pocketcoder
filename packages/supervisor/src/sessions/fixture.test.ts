import { digestOf } from "@pstdio/pocketcoder-contracts";

const uuid = () => crypto.randomUUID();
export function envelope() {
  const execution = {
    workspaceId: uuid(),
    incarnationId: "test",
    owner: "conversation-request" as const,
    requestId: uuid(),
  };
  const inputs = { workspaceId: execution.workspaceId, incarnationId: "test", objects: [] };
  const facts = {
    execution,
    callerPrincipalId: uuid(),
    templateDigest: digestOf("template"),
    adapterDigest: digestOf("adapter"),
    operation: "message",
    input: { message: "hello\nUnicode: å  " },
    inputs: { ...inputs, digest: digestOf(inputs) },
    bindingSetDigest: digestOf([]),
  };
  return {
    acceptance: { ...facts, fingerprint: digestOf(facts) },
    conversationIdentity: {
      schema: "pocketcoder.conversation/v2" as const,
      authority: "external" as const,
      conversation_id: uuid(),
      request_id: uuid(),
      turn_id: execution.requestId,
      request_fingerprint: digestOf(facts).slice(7),
    },
  };
}

export function envelopeWithFiles(names: string[]) {
  const input = envelope();
  const objects = names.map((name) => ({
    workspaceId: input.acceptance.execution.workspaceId,
    objectVersion: digestOf(name),
    fileId: crypto.randomUUID(),
    name,
    mediaType: "text/plain",
    sizeBytes: 1,
    digest: digestOf(name),
    visibility: "ready" as const,
  }));
  const contents = { ...input.acceptance.inputs, objects };
  const { digest: _, ...manifest } = contents;
  const { fingerprint: __, ...facts } = input.acceptance;
  const acceptance = { ...facts, inputs: { ...manifest, digest: digestOf(manifest) } };
  return { ...input, acceptance: { ...acceptance, fingerprint: digestOf(acceptance) } };
}
