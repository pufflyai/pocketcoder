import { randomUUID } from "node:crypto";
import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";
import { sessionOption } from "./options";

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const requestOption = (command: Argv) =>
  sessionOption(command).option("request", { type: "string", demandOption: true, description: "Request ID" });

export function addRequestCommands(parser: Argv) {
  let commands = addAction(
    parser,
    "submit",
    "Submit a request; resend the printed body unchanged after a lost reply",
    (command) =>
      sessionOption(command)
        .option("request", { type: "string", description: "Request ID (generated when omitted)" })
        .option("message", { type: "string", demandOption: true })
        .option("input", { type: "string", array: true, description: "Ready input ID to attach (repeatable)" }),
    async (flags) => {
      const client = controlPlaneClient();
      const sessionId = need(flags, "session");
      const inputs = Array.isArray(flags.input) ? (flags.input as string[]) : [];
      const attachments = inputs;
      const body = {
        requestId: typeof flags.request === "string" ? flags.request : randomUUID(),
        message: need(flags, "message"),
        attachments,
      };
      // Print the intent before sending so a caller can replay it exactly.
      console.error(JSON.stringify({ submit: body }));
      print(await client.requests.submit(sessionId, body));
    },
  );
  commands = addAction(
    commands,
    "request",
    "Get a request's durable state and outcome",
    requestOption,
    async (flags) => {
      print(await controlPlaneClient().requests.get(need(flags, "session"), need(flags, "request")));
    },
  );
  commands = addAction(
    commands,
    "cancel",
    "Cancel one request without touching other sessions",
    (command) =>
      sessionOption(command).option("request", { type: "string", description: "Omit to cancel the whole session" }),
    async (flags) => {
      print(
        typeof flags.request === "string"
          ? await controlPlaneClient().requests.cancel(need(flags, "session"), flags.request)
          : await controlPlaneClient().sessions.cancel(need(flags, "session")),
      );
    },
  );
  return addAction(
    commands,
    "collection",
    "Get a request's collection receipt, including empty and lost results",
    requestOption,
    async (flags) => {
      print(await controlPlaneClient().requests.collection(need(flags, "session"), need(flags, "request")));
    },
  );
}
