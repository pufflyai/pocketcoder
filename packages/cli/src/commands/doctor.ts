import { randomUUID } from "node:crypto";
import type { Argv } from "yargs";
import { controlPlaneClient, type Flags, fail, need } from "../command/cli-context";
import { addAction } from "./command";

export function addDoctorCommand(parser: Argv) {
  return addAction(
    parser,
    "doctor",
    "Create, probe, and cancel a diagnostic workspace",
    (command) =>
      command
        .option("template", {
          type: "string",
          demandOption: true,
          description: "Template name",
        })
        .option("turn-timeout-seconds", {
          type: "number",
          default: 60,
          description: "Maximum wait for agent input readiness and, separately, its diagnostic response",
        }),
    runDoctor,
  );
}

async function runDoctor(flags: Flags) {
  const template = need(flags, "template");
  const externalId = `doctor-${randomUUID()}`;
  console.log(`doctor: creating probe workspace from template ${template}`);
  const workspace = await controlPlaneClient().workspaces.create({
    externalId,
    templateName: template,
  });
  let failure: Error | null = null;
  try {
    console.log(`doctor: workspace ${workspace.id} queued; waiting for ready`);
    await waitUntilReady(workspace.id);
    console.log("doctor: workspace ready; probing a structured session");
    const timeoutSeconds = turnTimeout(flags);
    await runTurn(workspace.id, timeoutSeconds);
    console.log("doctor: correlated agent response received");
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    await printFailureTail(workspace.id);
  } finally {
    console.log("doctor: canceling probe workspace");
    await controlPlaneClient()
      .workspaces.cancel(workspace.id)
      .catch(() => {});
  }
  if (failure) fail(failure.message);
  console.log("doctor: ok");
}

function turnTimeout(flags: Flags) {
  const timeout =
    typeof flags["turn-timeout-seconds"] === "number"
      ? flags["turn-timeout-seconds"]
      : Number(flags["turn-timeout-seconds"] ?? 60);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
    fail("--turn-timeout-seconds must be an integer from 1 to 300");
  }
  return timeout;
}

async function waitUntilReady(workspaceId: string) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const workspace = await controlPlaneClient().workspaces.get(workspaceId);
    if (workspace.state === "ready") return;
    if (["failed", "canceled", "expired", "preserved", "succeeded"].includes(workspace.state)) {
      throw new Error(`workspace reached ${workspace.state} (${workspace.reason_code ?? "no reason"})`);
    }
    await Bun.sleep(2000);
  }
  throw new Error("workspace did not become ready within 5 minutes");
}

async function runTurn(workspaceId: string, timeoutSeconds: number) {
  const client = controlPlaneClient();
  const nonce = `pocketcoder-doctor-${randomUUID()}`;
  const request = {
    requestId: randomUUID(),
    conversationId: randomUUID(),
    message: `Reply with exactly this diagnostic token: ${nonce}`,
    files: [],
  };
  await client.workspaceRequests.submit(workspaceId, request);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const receipt = await client.workspaceRequests.get(workspaceId, request.requestId, request.conversationId);
    if (receipt.finalizedAt) {
      const history = await client.conversations.read(workspaceId, request.conversationId);
      if (
        history.items.some(
          (message) =>
            message.role === "assistant" &&
            message.parts?.some((part) => part.type === "text" && part.text.includes(nonce)),
        )
      )
        return;
      throw new Error("Session finished without the diagnostic token.");
    }
    await Bun.sleep(500);
  }
  throw new Error(`Session did not finish within ${timeoutSeconds} seconds`);
}

async function printFailureTail(workspaceId: string) {
  try {
    const workspace = await controlPlaneClient().workspaces.get(workspaceId);
    if (workspace.failure?.log_tail) process.stderr.write(`${workspace.failure.log_tail}\n`);
  } catch {
    // The original diagnostic failure remains authoritative.
  }
}
