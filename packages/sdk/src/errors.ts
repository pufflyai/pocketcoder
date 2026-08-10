import {
  type ErrorCode,
  ErrorEnvelopeSchema,
  type WorkspaceResource,
} from "@pstdio/pocketcoder-contracts";
import { z } from "zod";

const ClientErrorCodeSchema = z.enum(["client.non_json_response", "client.invalid_response"]);
export type ClientErrorCode = z.infer<typeof ClientErrorCodeSchema>;

export class PocketCoderError extends Error {
  readonly code: ErrorCode | ClientErrorCode;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(input: {
    message: string;
    code: ErrorCode | ClientErrorCode;
    status: number;
    requestId?: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "PocketCoderError";
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
    this.details = input.details;
  }
}

export class ConversationGoneError extends PocketCoderError {}

export class WorkspaceTerminalError extends Error {
  readonly workspace: WorkspaceResource;

  constructor(workspace: WorkspaceResource) {
    const reason = workspace.reason_code ?? workspace.failure?.reason_code ?? "no reason";
    const tail = workspace.failure?.log_tail.trim();
    super(
      [
        `workspace ${workspace.id} reached ${workspace.state} (${reason})`,
        ...(tail ? [`failure log:\n${tail}`] : []),
      ].join("\n"),
    );
    this.name = "WorkspaceTerminalError";
    this.workspace = workspace;
  }
}

export function responseError(response: Response, body: unknown) {
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return new PocketCoderError({
      message: `PocketCoder returned an invalid error response (${response.status})`,
      code: "client.invalid_response",
      status: response.status,
    });
  }
  const { code, message, request_id: requestId, details } = parsed.data.error;
  const ErrorType =
    code === "conversation.deleted" || code === "conversation.expired"
      ? ConversationGoneError
      : PocketCoderError;
  return new ErrorType({ message, code, status: response.status, requestId, details });
}
