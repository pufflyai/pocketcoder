import { randomUUID } from "node:crypto";
import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../cli-context";
import { addAction } from "../command";
import { idOption } from "./options";

export function addVerifyCommand(parser: Argv) {
  return addAction(
    parser,
    "verify",
    "Verify checkpoint manifest and content",
    idOption,
    async (flags) => {
      const id = need(flags, "id");
      console.log(
        JSON.stringify(
          await controlPlaneClient().checkpoints.verify(id, `verify-${id}-${randomUUID()}`),
          null,
          2,
        ),
      );
    },
  );
}
