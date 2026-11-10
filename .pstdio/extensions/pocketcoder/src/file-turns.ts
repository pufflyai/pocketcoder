import { randomUUID } from "node:crypto";
import type {
  HarnessAttachment,
  HarnessContext,
  HarnessReattachInput,
  HarnessSession,
  HarnessStartInput,
  SessionMessage,
} from "@pstdio/sdk/extensions";
import { type createInstances, PocketCoderHttpError } from "./instances";

type Instances = ReturnType<typeof createInstances>;
type Target = { instanceId: string; machineId: string; sessionId: string; instances: Instances };
type InputReference = { fileId: string; name: string } & Record<string, unknown>;
type Receipt = {
  acceptance: { execution: { requestId: string }; input: { content: string }; inputs: { objects: InputReference[] } };
  phase: string;
  finalizedAt: string | null;
  outcome: unknown;
};
type Request = { requestId: string; conversationId: string; content: string; files: InputReference[] };
type Pending = { target: string; request: Request };
const path = (ref: Target) => `/v1/workspaces/${ref.machineId}/agent/requests`;
const key = (sessionId: string) => `file-turn:${sessionId}`;
type FilePresentation = Pick<HarnessAttachment, "fileId" | "fileName" | "mimeType" | "sizeBytes" | "url">;

export async function supportsFileTurns(ref: Target, signal?: AbortSignal) {
  try {
    return await ref.instances.request<{ requests: boolean; attachments: boolean }>(
      ref.instanceId,
      `/v1/workspaces/${ref.machineId}/agent/capabilities`,
      { signal },
    );
  } catch (error) {
    if (error instanceof PocketCoderHttpError && error.status === 422 && error.code === "relay.route_not_allowed")
      return { requests: false, attachments: false };
    throw error;
  }
}

async function upload(ref: Target, input: HarnessStartInput) {
  const files: InputReference[] = [];
  for (const attachment of input.attachments ?? []) {
    input.signal?.throwIfAborted();
    const file = Bun.file(attachment.localPath);
    if (file.size !== attachment.sizeBytes) throw new Error(`Attachment changed: ${attachment.fileName}`);
    const hash = new Bun.CryptoHasher("sha256");
    const reader = file.stream().getReader();
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        input.signal?.throwIfAborted();
        hash.update(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const reference = await ref.instances.request<InputReference>(
      ref.instanceId,
      `/v1/workspaces/${ref.machineId}/attachments/${attachment.fileId}`,
      {
        method: "PUT",
        signal: input.signal,
        headers: {
          "content-type": attachment.mimeType ?? "application/octet-stream",
          "content-length": String(file.size),
          "x-content-sha256": hash.digest("hex"),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
        },
        body: file,
      },
    );
    files.push(reference);
  }
  return files;
}

async function read(ref: Target, request: Pick<Request, "requestId" | "conversationId">, signal?: AbortSignal) {
  return ref.instances.request<Receipt>(
    ref.instanceId,
    `${path(ref)}/${request.requestId}?conversationId=${request.conversationId}`,
    { signal },
  );
}

export async function fileTurnMessages(ctx: HarnessContext, ref: Target, sessionId: string, signal?: AbortSignal) {
  const receipts: Receipt[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ conversationId: sessionId, limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await ref.instances.request<{ items: Receipt[]; next_cursor: string | null }>(
      ref.instanceId,
      `${path(ref)}?${query}`,
      { signal },
    );
    receipts.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  const messages: SessionMessage[] = [];
  for (const receipt of receipts) {
    const requestId = receipt.acceptance.execution.requestId;
    const names = receipt.acceptance.inputs.objects.map((file) => file.name);
    messages.push({
      id: `pocketcoder:${requestId}:user`,
      role: "user",
      index: messages.length,
      parts: [
        {
          type: "text",
          text: receipt.acceptance.input.content + (names.length ? `\n\nFiles: ${names.join(", ")}` : ""),
        },
      ],
    });
    for (const object of receipt.acceptance.inputs.objects) {
      const file = await ctx.state.get<FilePresentation>(`file-presentation:${sessionId}:${object.fileId}`);
      if (file)
        messages[messages.length - 1]?.parts.push({
          type: "file",
          fileId: file.fileId,
          filename: file.fileName,
          mediaType: file.mimeType ?? "application/octet-stream",
          size: file.sizeBytes,
          url: file.url,
        });
    }
    if (receipt.phase === "terminal") {
      const outcome = receipt.outcome;
      const content =
        outcome && typeof outcome === "object" && "content" in outcome && typeof outcome.content === "string"
          ? outcome.content
          : JSON.stringify(outcome);
      messages.push({
        id: `pocketcoder:${requestId}:assistant`,
        role: "assistant",
        index: messages.length,
        parts: [{ type: "text", text: content }],
      });
    }
  }
  return messages;
}

export async function startFileTurn(
  ctx: HarnessContext,
  input: HarnessStartInput & { agentSessionId?: string },
  ref: Target,
): Promise<HarnessSession> {
  if (await ctx.state.get(key(input.sessionId)))
    throw new Error("Reconnect to the pending request before sending another message.");
  const conversationKey = `file-conversation:${input.sessionId}`;
  let conversationId = await ctx.state.get<string>(conversationKey);
  if (input.agentSessionId?.startsWith(`${ref.sessionId}:`))
    conversationId = input.agentSessionId.slice(ref.sessionId.length + 1);
  conversationId ??= randomUUID();
  await ctx.state.set(conversationKey, conversationId);
  if (!input.prompt.trim() && !input.attachments?.length)
    return {
      agentSessionId: `${ref.sessionId}:${conversationId}`,
      done: Promise.resolve({ status: "completed" }),
      stop() {},
    };
  const files = await upload(ref, input);
  for (const { fileId, fileName, mimeType, sizeBytes, url } of input.attachments ?? [])
    await ctx.state.set(`file-presentation:${conversationId}:${fileId}`, {
      fileId,
      fileName,
      mimeType,
      sizeBytes,
      url,
    });
  const request: Request = {
    requestId: randomUUID(),
    conversationId,
    content: input.prompt || "Read the attached files.",
    files,
  };
  await ctx.state.set(key(input.sessionId), { target: ref.sessionId, request });
  return observeFileTurn(ctx, input, ref, { target: ref.sessionId, request }, true);
}

export async function reconnectFileTurn(ctx: HarnessContext, input: HarnessReattachInput, ref: Target) {
  const pending = await ctx.state.get<Pending>(key(input.sessionId));
  if (!pending) return null;
  if (pending.target !== ref.sessionId) throw new Error("The pending request belongs to another workspace.");
  return observeFileTurn(ctx, input, ref, pending, false);
}

async function observeFileTurn(
  ctx: HarnessContext,
  input: HarnessStartInput | HarnessReattachInput,
  ref: Target,
  pending: Pending,
  firstSubmission: boolean,
): Promise<HarnessSession> {
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  const done = (async () => {
    // Replaying this exact saved body is safe even when the first response was lost.
    try {
      await ref.instances.request(ref.instanceId, path(ref), {
        method: "POST",
        body: JSON.stringify(pending.request),
        signal,
      });
    } catch (error) {
      // A replay can follow a lost acceptance response. Only a rejected first
      // submission proves that this saved request never reached execution.
      if (firstSubmission && error instanceof PocketCoderHttpError && [400, 413, 422].includes(error.status)) {
        await ctx.state.delete(key(input.sessionId));
        ctx.logger.warn(error.message);
        return { status: "failed" as const };
      }
      throw error;
    }
    while (!signal.aborted) {
      const receipt = await read(ref, pending.request, signal);
      input.events.push({
        op: "replace",
        path: "/messages",
        value: await fileTurnMessages(ctx, ref, pending.request.conversationId, signal),
      });
      if (receipt.finalizedAt) {
        await ctx.state.delete(key(input.sessionId));
        return { status: receipt.phase === "terminal" ? ("completed" as const) : ("failed" as const) };
      }
      if (["unknown", "lost", "canceled"].includes(receipt.phase)) return { status: "failed" as const };
      await Bun.sleep(250);
    }
    return { status: "disconnected" as const };
  })().catch((error: unknown) => {
    if (!signal.aborted) ctx.logger.warn(`PocketCoder request connection ended: ${String(error)}`);
    return { status: "disconnected" as const };
  });
  return {
    agentSessionId: `${ref.sessionId}:${pending.request.conversationId}`,
    timeoutStrategy: "provider",
    stop: () => controller.abort(),
    done,
  };
}
