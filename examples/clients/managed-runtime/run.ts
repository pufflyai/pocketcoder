// Configure a profile in the controller's principals file, then use its sessions-only key here.
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { ManagedRuntimeConsumer } from "./consumer";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const client = new PocketCoderClient({ baseUrl: required("POCKETCODER_URL"), apiKey: required("POCKETCODER_KEY") });
const user = "example-user";
const consumer = new ManagedRuntimeConsumer(client, { canUse: (id) => id === user });
const session = await consumer.startSession(process.env.POCKETCODER_PROFILE ?? "chat", user);
const request = await consumer.ask(user, session.sessionId, process.argv[2] ?? "Hello from the reference consumer");
console.log(await consumer.waitFor(user, session.sessionId, request.requestId));
await consumer.close(user, session.sessionId);
