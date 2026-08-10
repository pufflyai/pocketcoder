import type { Argv } from "yargs";
import { api, fail } from "../../cli-context";
import { addAction } from "../command";
import { chatWorkspace } from "./chat-session";
import { attachOptions } from "./options";

export function addChatCommand(parser: Argv) {
  return addAction(
    parser,
    "chat",
    "Hold an interactive AgentAPI conversation",
    (command) =>
      attachOptions(command)
        .option("follow", {
          type: "boolean",
          description: "Continue following messages until interrupted",
        })
        .option("poll-interval-ms", {
          type: "number",
          default: 500,
          description: "Agent message polling interval",
        })
        .option("response-timeout-seconds", {
          type: "number",
          default: 600,
          description: "Maximum time to wait for each agent response",
        })
        .option("cancel-on-exit", {
          type: "boolean",
          description: "Cancel the workspace when chat exits",
        }),
    async (flags) => chatWorkspace(flags, { api, fail }),
  );
}
