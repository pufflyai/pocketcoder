// Runs the reference consumer once against a controller:
//   POCKETCODER_URL=... POCKETCODER_KEY=<owner key> POCKETCODER_PRINCIPAL_ID=... \
//   POCKETCODER_TEMPLATE_DIGEST=sha256:... bun examples/clients/managed-runtime/run.ts "your message"
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { ManagedRuntimeConsumer } from "./consumer";
import { IntentFile } from "./intents";
import { provision } from "./provision";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const client = new PocketCoderClient({ baseUrl: env("POCKETCODER_URL"), apiKey: env("POCKETCODER_KEY") });
const { scopeId, profile } = await provision(client, {
  principalId: env("POCKETCODER_PRINCIPAL_ID"),
  templateDigest: env("POCKETCODER_TEMPLATE_DIGEST"),
  limits: { workspaceStarts: 10, maxActiveWorkspaces: 2, maxChatProcessesPerWorkspace: 4 },
});
const user = "example-user";
const consumer = new ManagedRuntimeConsumer(
  client,
  await IntentFile.open(join(tmpdir(), "pocketcoder-managed-runtime-intents.json")),
  { canUse: (userId) => userId === user },
);
const session = await consumer.startSession(profile);
const request = await consumer.ask(user, session.sessionId, process.argv[2] ?? "Hello from the reference consumer");
const result = await consumer.waitFor(user, session.sessionId, request.requestId);
console.log(JSON.stringify({ outcome: result.request.outcome, collection: result.collection.completeness }, null, 2));
console.log(JSON.stringify(await client.authority.usage(scopeId), null, 2));
await consumer.close(user, session.sessionId);
