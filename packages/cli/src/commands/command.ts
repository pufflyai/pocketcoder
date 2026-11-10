import type { Argv } from "yargs";
import { type Flags, loadProjectEnvironment } from "../command/cli-context";

type Configure = (command: Argv) => Argv;
type Run = (flags: Flags) => Promise<void> | void;

interface ActionOptions {
  // Internal child processes inherit an already resolved environment.
  loadEnvironment?: boolean;
}

export function addAction(
  parser: Argv,
  command: string,
  description: string | false,
  configure: Configure,
  run: Run,
  options: ActionOptions = {},
) {
  return parser.command({
    command,
    describe: description,
    builder: configure,
    handler: async (arguments_) => {
      const flags = arguments_ as unknown as Flags;
      if (options.loadEnvironment !== false) loadProjectEnvironment(flags);
      await run(flags);
    },
  });
}

export function addResource(parser: Argv, name: string, description: string, configure: Configure) {
  return parser.command(`${name} <command>`, description, (commands) =>
    configure(commands).demandCommand(1, `A ${name} command is required.`).strict(),
  );
}

export function unchanged(command: Argv) {
  return command;
}
