import { basename } from "node:path";
import { createInterface } from "node:readline";
import {
  type ConversationMessageInput,
  type InputObjectReference,
  type PocketCoderClient,
  PocketCoderError,
} from "@pstdio/pocketcoder-sdk";
import { z } from "zod";
import { fileFlags, handleAttachmentCommand, mediaTypeOf } from "./attachments";
import { chatState } from "./chat-state";

export type ApiRequest = (path: string, init?: RequestInit) => Promise<Response>;
export type ChatFlags = Record<string, unknown>;
export interface WorkspaceChatDeps {
  client: PocketCoderClient;
  fail(message: string): never;
}

export function printMessage(message: ConversationMessageInput, json: boolean) {
  if (json) {
    console.log(JSON.stringify(message));
    return;
  }
  for (const part of message.parts ?? [{ type: "text", text: message.content }]) {
    if (part.type === "text") console.log(`${message.role}> ${part.text}`);
    if (part.type === "tool")
      console.log(`${part.name} (${part.status}) ${part.output_text ?? JSON.stringify(part.output ?? part.input)}`);
    if (part.type === "error") console.error(`${part.code}: ${part.message}`);
    if (part.type === "file") console.log(`file> ${part.name} (${part.size_bytes} bytes)`);
  }
}

async function messages(client: PocketCoderClient, id: string, conversationId: string) {
  const open = await client.conversations.open(id);
  const current = new Map<string, ConversationMessageInput>();
  for (const turn of open.turns)
    if (turn.type === "turn" && turn.conversation_id === conversationId)
      for (const message of turn.messages) current.set(message.message_id, message);
  let cursor: string | undefined;
  do {
    const page = await client.conversations.read(id, conversationId, { cursor, limit: 200 }).catch((error) => {
      if (error instanceof PocketCoderError && error.code === "conversation.not_found")
        return { items: [], nextCursor: null };
      throw error;
    });
    for (const message of page.items) current.set(message.message_id, message);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return [...current.values()]
    .filter((message) => message.identity?.fact?.type !== "turn_terminal")
    .sort(
      (a, b) =>
        Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
        (a.identity?.sequence ?? 0) - (b.identity?.sequence ?? 0),
    );
}

export async function attachWorkspace(flags: ChatFlags, deps: WorkspaceChatDeps) {
  return chatWorkspace({ ...flags, attach: true }, deps);
}

export async function chatWorkspace(flags: ChatFlags, { client, fail }: WorkspaceChatDeps) {
  const { id, state, save, poll, timeout } = chatOptions(flags, fail);
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const queue = fileFlags(flags.file);
  if (queue.length && (typeof flags.message !== "string" || !flags.message.trim())) fail("--file requires --message");
  const printed = new Map<string, number>();
  const show = async () => {
    for (const message of await messages(client, id, state.conversationId)) {
      const revision = message.identity?.revision ?? 1;
      if ((printed.get(message.message_id) ?? 0) >= revision) continue;
      printMessage(message, flags.json === true);
      printed.set(message.message_id, revision);
    }
  };
  const send = async (message: string) => {
    if (!state.pending) {
      const files: InputObjectReference[] = [];
      for (const path of queue) {
        const file = Bun.file(path);
        files.push(
          await client.attachments.upload(id, {
            name: basename(path),
            mediaType: mediaTypeOf(path),
            body: file,
            sizeBytes: file.size,
            signal: abort.signal,
          }),
        );
      }
      queue.length = 0;
      state.pending = { requestId: crypto.randomUUID(), conversationId: state.conversationId, message, files };
      save();
    }
    // Save the exact request before dispatch so reconnect cannot create a second turn.
    const input = state.pending;
    await client.workspaceRequests.submit(id, input, { signal: abort.signal });
    const deadline = Date.now() + timeout;
    while (!abort.signal.aborted) {
      const receipt = await client.workspaceRequests.get(id, input.requestId, state.conversationId, {
        signal: abort.signal,
      });
      await show();
      if (receipt.finalizedAt) {
        delete state.pending;
        save();
        return;
      }
      if (Date.now() >= deadline) fail("Request is still running. Reconnect with the same workspace and conversation.");
      await Bun.sleep(poll);
    }
  };
  try {
    const recovering = state.pending?.message;
    if (state.pending) await send(state.pending.message);
    if (typeof flags.message === "string" && flags.message !== recovering) await send(flags.message);
    else if (typeof flags.message === "string") return;
    else if (flags.attach === true) await show();
    else {
      await interactive(queue, abort.signal, send, interrupt);
    }
    while (flags.follow === true && !abort.signal.aborted) {
      await show();
      await Bun.sleep(poll);
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (flags["cancel-on-exit"] === true) await client.workspaces.cancel(id);
    if (abort.signal.aborted) process.exitCode = 130;
  }
}

function chatOptions(flags: ChatFlags, fail: WorkspaceChatDeps["fail"]) {
  const id = z.uuid().parse(flags.id);
  const conversation = typeof flags.conversation === "string" ? z.uuid().parse(flags.conversation) : undefined;
  const { state, save } = chatState(id, conversation);
  const poll = Number(flags["poll-interval-ms"] ?? 500);
  const timeout = Number(flags["response-timeout-seconds"] ?? 600) * 1000;
  if (!Number.isInteger(poll) || poll < 100 || poll > 10_000) fail("--poll-interval-ms must be from 100 to 10000");
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 3_600_000)
    fail("--response-timeout-seconds must be from 1 to 3600");

  return { id, conversation, state, save, poll, timeout };
}
async function interactive(
  queue: string[],
  signal: AbortSignal,
  send: (message: string) => Promise<void>,
  interrupt: () => void,
) {
  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const close = () => readline.close();
  signal.addEventListener("abort", close, { once: true });
  readline.on("SIGINT", interrupt);
  try {
    for await (const line of readline) {
      if (signal.aborted) break;
      if (!handleAttachmentCommand(line, queue, console.log) && line.trim()) await send(line);
    }
  } finally {
    signal.removeEventListener("abort", close);
    readline.close();
  }
}
