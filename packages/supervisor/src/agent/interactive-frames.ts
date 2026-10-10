import type { ServerFrame } from "@pstdio/pocketcoder-contracts";
import type { AttachmentManager } from "../attachments/attachments";
import type { TerminalManager } from "../terminals/terminal-manager";

export async function handleInteractiveFrame(
  frame: ServerFrame,
  terminals: TerminalManager,
  attachments: AttachmentManager,
) {
  switch (frame.type) {
    case "terminal_open":
      terminals.open(frame.payload);
      return true;
    case "terminal_input":
      terminals.input(frame.payload);
      return true;
    case "terminal_resize":
      terminals.resize(frame.payload);
      return true;
    case "terminal_close":
      await terminals.close(frame.payload);
      return true;
    case "attachment_start":
      await attachments.handleStart(frame.payload);
      return true;
    case "attachment_chunk":
      await attachments.handleChunk(frame.payload);
      return true;
    case "attachment_finish":
      await attachments.handleFinish(frame.payload);
      return true;
    case "attachment_abort":
      await attachments.handleAbort(frame.payload);
      return true;
    case "attachment_resolve":
      await attachments.handleResolve(frame.payload);
      return true;
  }
  return false;
}
