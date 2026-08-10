import type { Argv } from "yargs";
import { api, fail } from "../../cli-context";
import { addAction } from "../command";
import { attachWorkspace } from "./chat-session";
import { attachOptions } from "./options";

export function addAttachCommand(parser: Argv) {
  return addAction(
    parser,
    "attach",
    "Read or send AgentAPI messages on a live workspace",
    attachOptions,
    async (flags) => attachWorkspace(flags, { api, fail }),
  );
}
