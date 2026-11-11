import { waitFor } from "./local-process";
import { type ExampleRequest, exampleSession } from "./session";

export async function proveTurnInterrupt(
  request: ExampleRequest,
  workspaceId: string,
  prompt: string,
  settleTimeoutMs: number,
  conversationId?: string,
) {
  const session = exampleSession(request, workspaceId, conversationId);
  const observer = new AbortController();
  const events = await request(`/v1/workspaces/${workspaceId}/conversations/${session.conversationId}/live`, {
    signal: observer.signal,
  });
  if (!events.ok) throw new Error("Native stream did not open");
  const receipt = await session.send(prompt);
  await waitFor(async () => (await session.read(receipt)).phase === "running", 60_000, "native request to run");
  observer.abort();
  await Bun.sleep(2000);
  if ((await session.read(receipt)).phase !== "running") throw new Error("Disconnect stopped accepted work");
  const started = Date.now();
  const cancelId = crypto.randomUUID();
  await session.cancel(receipt, cancelId);
  await session.wait(receipt, settleTimeoutMs);
  const repeated = await session.cancel(receipt, cancelId);
  if (!repeated.finalizedAt) throw new Error("Repeated cancellation did not replay its receipt");
  return { settledInMs: Date.now() - started };
}
