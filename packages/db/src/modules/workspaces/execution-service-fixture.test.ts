import { randomUUID } from "node:crypto";
import type { WorkloadTemplate } from "@pstdio/pocketcoder-contracts";

export function serviceExecutionTemplate(source: WorkloadTemplate, port = 12345) {
  source.spec.profile = "service";
  for (const operation of Object.values(source.spec.operations)) operation.outputRoots = [];
  const adapter = source.spec.adapters.main;
  if (!adapter) throw new Error("Fixture adapter missing");
  adapter.kind = "service";
  adapter.protocol = "pocketcoder.execution/v1";
  adapter.service = "agent";
  delete adapter.command;
  source.spec.services = {
    agent: {
      baseUrl: `http://127.0.0.1:${port}`,
      required: false,
      healthPath: "/status",
      routes: ["accept", "lookup", "cancel", "ack"].map((action) => ({
        method: "POST",
        path: `/executions/${action}`,
        query: [],
        responseMode: "buffered",
        maxRequestBytes: 65536,
        maxResponseBytes: 65536,
        deadlineSeconds: 1,
      })),
    },
  };
}

export function executionConversationIdentity(requestId: string, conversationId = randomUUID()) {
  return {
    schema: "pocketcoder.conversation/v2" as const,
    authority: "external" as const,
    conversation_id: conversationId,
    request_id: requestId,
    turn_id: randomUUID(),
    request_fingerprint: "a".repeat(64),
  };
}
