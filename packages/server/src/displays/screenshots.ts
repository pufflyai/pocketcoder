import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ApiError,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MIN_PROTOCOL_VERSION,
  type ScreenshotResource,
} from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { Hub } from "../control-channel/hub";
import { PreviewSessions } from "../previews/sessions";
import type { WorkspaceService } from "../workspaces/service";
import { screenshotBody } from "./screenshot-body";

export interface ScreenshotOptions {
  agentBaseUrl: string;
  readCapacity: Parameters<Store["binaryOutputs"]["begin"]>[1];
  retentionMs?: number;
}
interface Capture {
  abort: AbortController;
  check(): void;
  validate(): Promise<unknown>;
  uploaded: boolean;
  resolve(value: ScreenshotResource): void;
  reject(error: unknown): void;
}

export function createScreenshots(deps: {
  store: Store;
  hub: Hub;
  service: WorkspaceService;
  options: ScreenshotOptions;
}) {
  const { store, hub, options } = deps;
  const sessions = new PreviewSessions(store, deps.service);
  const active = new Map<string, Capture>();
  let closing = false;
  let admitted = 0;
  const jobs = new Set<Promise<unknown>>();
  async function capture(workspaceId: string, keyId: string, signal: AbortSignal) {
    if (closing || admitted >= 4) throw new ApiError("operation.conflict", "Screenshot capture capacity is full.");
    admitted++;
    const id = randomUUID();
    const abort = new AbortController();
    const cancelled = () => abort.abort();
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) abort.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    try {
      const session = {
        workspaceId,
        keyId,
        name: "display",
        origin: "",
        mode: "local" as const,
        expires: Date.now() + 10_000,
      };
      const { workspace, key } = await sessions.authorize(session);
      const connection = hub.get(workspaceId);
      if (!connection?.registered || connection.protocolVersion < SCREENSHOT_MIN_PROTOCOL_VERSION)
        throw new ApiError("workspace.disconnected", "Screenshot supervisor is unavailable.");
      const expiresAt = new Date(
        Math.min(session.expires, workspace.deadlineAt.getTime(), key.expiresAt?.getTime() ?? Infinity),
      );
      const check = () => {
        abort.signal.throwIfAborted();
        if (closing || expiresAt <= new Date() || hub.get(workspaceId) !== connection || !connection.registered)
          throw new ApiError("operation.conflict", "Screenshot capture authority changed.");
      };
      timeout = setTimeout(cancelled, Math.max(1, expiresAt.getTime() - Date.now()));
      const secret = randomBytes(32).toString("base64url");
      await store.binaryOutputs.begin(
        {
          id,
          workspaceId,
          principalId: workspace.principalId,
          keyId,
          reservationId: randomUUID(),
          connectionEpoch: connection.epoch,
          grantDigest: createHash("sha256").update(secret).digest(),
          expiresAt,
          retainedUntil: new Date(Date.now() + (options.retentionMs ?? 24 * 60 * 60_000)),
          reservedBytes: 3 * SCREENSHOT_MAX_BYTES + 64 * 1024,
        },
        options.readCapacity,
        check,
      );
      check();
      const result = new Promise<ScreenshotResource>((resolve, reject) => {
        active.set(id, { abort, check, validate: () => sessions.authorize(session), uploaded: false, resolve, reject });
        abort.signal.addEventListener(
          "abort",
          () => reject(new ApiError("operation.conflict", "Screenshot capture ended.")),
          { once: true },
        );
      });
      poll = setInterval(() => {
        try {
          check();
        } catch {
          cancelled();
          return;
        }
        void sessions.authorize(session).catch(cancelled);
      }, 250);
      hub.send(connection, "screenshot_capture", {
        output_id: id,
        credential: secret,
        expires_at: expiresAt.toISOString(),
        url: new URL(`/v1/agent/screenshots/${id}`, options.agentBaseUrl).href,
      });
      return await result;
    } finally {
      clearTimeout(timeout);
      clearInterval(poll);
      active.delete(id);
      abort.abort();
      signal.removeEventListener("abort", cancelled);
      await store.binaryOutputs.discard(id);
      admitted--;
    }
  }
  async function upload(request: Request, id: string) {
    const context = active.get(id);
    const row = await store.binaryOutputs.get(id);
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const digest = createHash("sha256").update(token).digest();
    if (
      !context ||
      context.uploaded ||
      row?.state !== "capturing" ||
      !row.grantDigest ||
      !timingSafeEqual(digest, row.grantDigest)
    )
      throw new ApiError("auth.invalid_key", "Invalid screenshot capture grant.");
    context.check();
    context.uploaded = true;
    try {
      await context.validate();
      context.check();
      const bytes = await screenshotBody(request, context.abort.signal);
      const ready = await store.binaryOutputs.publish(id, bytes, context.check);
      if (!ready.bytes || !ready.digest) throw new Error("Screenshot publication receipt is missing.");
      const resource = {
        kind: "screenshot",
        id,
        workspace_id: row.workspaceId,
        content_type: "image/png",
        bytes: ready.bytes,
        digest: ready.digest,
        expires_at: ready.retainedUntil.toISOString(),
      } satisfies ScreenshotResource;
      context.resolve(resource);
      return new Response(null, { status: 204 });
    } catch (error) {
      context.reject(error);
      context.abort.abort();
      throw error;
    }
  }
  function track<T>(job: Promise<T>) {
    jobs.add(job);
    void job.finally(() => jobs.delete(job)).catch(() => {});
    return job;
  }
  return {
    capture: (...args: Parameters<typeof capture>) => track(capture(...args)),
    upload: (...args: Parameters<typeof upload>) => track(upload(...args)),
    async drain() {
      while (jobs.size) await Promise.allSettled([...jobs]);
    },
    async close() {
      closing = true;
      for (const value of active.values()) value.abort.abort();
      while (jobs.size) await Promise.allSettled([...jobs]);
    },
  };
}
export type Screenshots = ReturnType<typeof createScreenshots>;
