import { isPocketCoderErrorCode } from "@pstdio/pocketcoder-sdk";

export type RemoteRequestPhase =
  | "attachment"
  | "initial_messages"
  | "baseline_changes"
  | "initial_events"
  | "submit"
  | "reply_events"
  | "reply_messages"
  | "reply_status";

export interface RemoteRequestErrorInput {
  phase: RemoteRequestPhase;
  promptAccepted: boolean;
  status?: number;
  code?: string;
  cause?: unknown;
}

export class RemoteRequestError extends Error {
  readonly phase: RemoteRequestPhase;
  readonly promptAccepted: boolean;
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(input: RemoteRequestErrorInput) {
    const label = input.phase.replaceAll("_", " ");
    const suffix = input.status === undefined ? "" : ` (${input.status})`;
    super(
      `remote ${label} request failed${suffix}`,
      input.cause ? { cause: input.cause } : undefined,
    );
    this.name = "RemoteRequestError";
    this.phase = input.phase;
    this.promptAccepted = input.promptAccepted;
    this.status = input.status;
    this.code = input.code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function boundedText(response: Response, limit = 64 * 1024): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
}

function validatedCode(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const body: unknown = JSON.parse(text);
    if (!isRecord(body) || !isRecord(body.error)) return undefined;
    const { code, message, request_id: requestId } = body.error;
    if (
      typeof code !== "string" ||
      !isPocketCoderErrorCode(code) ||
      typeof message !== "string" ||
      typeof requestId !== "string"
    ) {
      return undefined;
    }
    return code;
  } catch {
    return undefined;
  }
}

export async function remoteResponseError(
  response: Response,
  phase: RemoteRequestPhase,
  promptAccepted: boolean,
): Promise<RemoteRequestError> {
  return new RemoteRequestError({
    phase,
    promptAccepted,
    status: response.status,
    code: validatedCode(await boundedText(response)),
  });
}
