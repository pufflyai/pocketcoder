// Uses existing CLI process ownership to quiesce its exact managed controller.
import { requestProcessQuiescence } from "@pstdio/pocketcoder-server/maintenance";
import type { Argv } from "yargs";
import { addAction } from "../command";
import { processIdentityMatches, readOwnedState, stateRoot } from "./state";

export async function quiesceManagedServer(timeoutSeconds: number) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 30)
    throw new Error("quiesce timeout must be from 1 to 30 seconds");
  const deadline = performance.now() + timeoutSeconds * 1000;
  const state = await readOwnedState();
  if (!state || !processIdentityMatches(state)) throw new Error("managed server process identity does not match");
  const result = await requestProcessQuiescence({
    root: stateRoot(),
    instanceId: state.instanceToken,
    pid: state.pid,
    timeoutSeconds: Math.floor((deadline - performance.now()) / 1000),
  });
  if (performance.now() >= deadline) throw new Error("controller control receipt arrived after deadline");
  console.log(JSON.stringify(result));
  if (performance.now() >= deadline) throw new Error("controller control output completed after deadline");
}

export function addQuiesceCommand(parser: Argv) {
  return addAction(
    parser,
    "quiesce",
    "Join userspace writers and retain the controller lease",
    (command) =>
      command.option("timeout-seconds", {
        type: "number",
        default: 15,
        description: "One quiesce attempt, at most 30 seconds",
      }),
    async (flags) => quiesceManagedServer(flags["timeout-seconds"] as number),
  );
}
