import { randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExecSpec } from "@pstdio/pocketcoder-contracts";

const LOG_CHUNK_LIMIT = 32 * 1024;

export async function verifyWritableMemoryPaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    const probePath = join(path, `.pocketcoder-write-probe-${randomUUID()}`);
    const expected = randomUUID();
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(probePath, "wx", 0o600);
      await handle.writeFile(expected, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      const actual = await readFile(probePath, "utf8");
      if (actual !== expected) {
        throw new Error("read-back content did not match");
      }
      await rm(probePath);
    } catch (error) {
      throw new Error(
        `writable memory preflight failed for ${path}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => {});
      await rm(probePath, { force: true }).catch(() => {});
    }
  }
}

export async function pumpLineFramedText(
  stream: ReadableStream<Uint8Array>,
  emit: (text: string) => void,
  capture?: (value: Uint8Array) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      capture?.(value);
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        emit(pending.slice(0, newline + 1));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
  } catch {
    // Stream ended with the process.
  } finally {
    pending += decoder.decode();
    if (pending !== "") emit(pending);
  }
}

export function splitUtf8Chunks(text: string, maxBytes = LOG_CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (chunkBytes + bytes > maxBytes && chunk !== "") {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += bytes;
  }
  if (chunk !== "") chunks.push(chunk);
  return chunks;
}

export function isConversationControlLine(text: string): boolean {
  return text.startsWith("POCKETCODER_CONVERSATION ");
}

export function enforcedEnvironment(
  exec: ExecSpec,
  overrides: Record<string, string | undefined> = {},
) {
  const environment = { ...process.env, ...exec.env, ...overrides };
  if (exec.network.mode !== "restricted") return environment;
  const noProxy = "127.0.0.1,localhost,::1";
  return {
    ...environment,
    HTTP_PROXY: exec.network.proxy_url,
    http_proxy: exec.network.proxy_url,
    HTTPS_PROXY: exec.network.proxy_url,
    https_proxy: exec.network.proxy_url,
    ALL_PROXY: "",
    all_proxy: "",
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
