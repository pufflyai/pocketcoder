import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction, addResource } from "../command";
import { sessionOption } from "./options";

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

export function addProfileCommands(parser: Argv) {
  return addResource(parser, "profiles", "Read configured session profiles", (commands) =>
    addAction(
      commands,
      "get",
      "Read a session profile",
      (command) => command.option("name", { type: "string", demandOption: true }),
      async (flags) => {
        print(await controlPlaneClient().profiles.get(need(flags, "name")));
      },
    ),
  );
}

export function addSessionReads(parser: Argv) {
  const commands = addAction(
    parser,
    "list",
    "List sessions for the current principal",
    (command) =>
      command.option("owner", { type: "string" }).option("state", {
        type: "string",
        choices: ["open", "provisioning", "ready", "suspended", "closed", "failed"] as const,
      }),
    async (flags) => {
      print(
        await controlPlaneClient().sessions.list({
          ...(typeof flags.owner === "string" ? { owner: flags.owner } : {}),
          ...(typeof flags.state === "string" ? { state: flags.state as "open" } : {}),
        }),
      );
    },
  );
  return addAction(
    commands,
    "conversation",
    "Poll conversation changes",
    (command) => sessionOption(command).option("after", { type: "string" }),
    async (flags) => {
      print(
        await controlPlaneClient().sessions.conversation(
          need(flags, "session"),
          typeof flags.after === "string" ? { after: flags.after } : {},
        ),
      );
    },
  );
}
