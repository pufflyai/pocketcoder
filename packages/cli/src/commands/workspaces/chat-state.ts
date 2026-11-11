import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkspaceRequest } from "@pstdio/pocketcoder-sdk";

export interface ChatState {
  conversationId: string;
  pending?: WorkspaceRequest;
}
export function chatState(workspaceId: string, conversationId?: string) {
  const root = process.env.POCKETCODER_STATE_DIR ?? join(homedir(), ".local", "state", "pocketcoder");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `chat-${workspaceId}.json`);
  let state: ChatState;
  try {
    state = JSON.parse(readFileSync(path, "utf8")) as ChatState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    state = { conversationId: conversationId ?? crypto.randomUUID() };
  }
  if (conversationId && state.conversationId !== conversationId) {
    if (state.pending) throw new Error("Reconnect to the pending request before switching conversations.");
    state = { conversationId };
  }
  const save = () => writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  save();
  return { state, save };
}
