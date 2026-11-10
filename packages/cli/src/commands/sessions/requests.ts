import { randomUUID } from "node:crypto";
import type { Argv } from "yargs";
import { controlPlaneClient, type Flags, fail, need } from "../../command/cli-context";
import { addAction } from "../command";
import { cancelIdOf, sessionOption } from "./options";

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const requestOption = (command: Argv) =>
  sessionOption(command).option("request", { type: "string", demandOption: true, description: "Request ID" });

// An absolute deadline is part of the request identity, so a retry must pass the same value.
function deadlineOf(flags: Flags) {
  if (typeof flags.deadline === "string") return new Date(flags.deadline).toISOString();
  const seconds = Number(flags["deadline-seconds"]);
  if (!Number.isFinite(seconds) || seconds <= 0) fail("pass --deadline or a positive --deadline-seconds");
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function addRequestCommands(parser: Argv) {
  let commands = addAction(
    parser,
    "submit",
    "Submit a request; resend the printed body unchanged after a lost reply",
    (command) =>
      sessionOption(command)
        .option("request", { type: "string", description: "Request ID (generated when omitted)" })
        .option("message", { type: "string", demandOption: true })
        .option("input", { type: "string", array: true, description: "Ready input ID to attach (repeatable)" })
        .option("deadline", { type: "string", description: "Absolute dispatch deadline (ISO 8601)" })
        .option("deadline-seconds", { type: "number", description: "Dispatch deadline from now" }),
    async (flags) => {
      const client = controlPlaneClient();
      const sessionId = need(flags, "session");
      const inputs = Array.isArray(flags.input) ? (flags.input as string[]) : [];
      const attachments = [];
      for (const inputId of inputs) attachments.push((await client.files.get(sessionId, inputId)).reference);
      const body = {
        requestId: typeof flags.request === "string" ? flags.request : randomUUID(),
        message: need(flags, "message"),
        attachments,
        dispatchDeadline: deadlineOf(flags),
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
      requestOption(command).option("cancel-id", { type: "string", description: "Stop command ID to retry" }),
    async (flags) => {
      print(
        await controlPlaneClient().requests.cancel(need(flags, "session"), need(flags, "request"), {
          cancelId: cancelIdOf(flags),
        }),
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
