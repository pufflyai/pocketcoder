import type { Argv } from "yargs";
import { controlPlaneClient, fail } from "../../command/cli-context";
import { addAction } from "../command";
import { attachWorkspace } from "./chat-session";
import { attachOptions } from "./options";

export function addAttachCommand(parser: Argv) {
  return addAction(
    parser,
    "attach",
    "Read or send structured session messages on a live workspace",
    attachOptions,
    async (flags) => attachWorkspace(flags, { client: controlPlaneClient(), fail }),
  );
}
