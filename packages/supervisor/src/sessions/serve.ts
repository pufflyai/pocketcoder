import {
  type ConversationMessageInput,
  PriorMessageSchema,
  WorkloadExecutionReferenceSchema,
} from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { echoRunner } from "./echo";
import { piRunner } from "./pi";
import { SessionProducer } from "./producer";

const Target = z.object({ execution: WorkloadExecutionReferenceSchema, fingerprint: z.string().optional() });

export function serveSessions(args: string[]) {
  const separator = args.indexOf("--");
  const command = separator < 0 ? [] : args.slice(separator + 1);
  const options = separator < 0 ? args : args.slice(0, separator);
  const adapter = options[0];
  if (adapter !== "echo" && adapter !== "pi") throw new Error("session serve requires echo or pi");
  if (adapter === "pi" && !command.length) throw new Error("Pi requires its native RPC command after --");
  const directory = process.env.POCKETCODER_SESSION_DIRECTORY ?? "/tmp/pocketcoder-sessions";
  const producer = new SessionProducer(
    `${directory}/requests`,
    adapter === "echo" ? echoRunner : piRunner(command, `${directory}/pi`),
    publishMessage,
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.POCKETCODER_SESSION_PORT ?? 3284),
    maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(request) {
      try {
        return await sessionResponse(producer, request);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
      }
    },
  });
  const shutdown = async () => {
    await producer.shutdown();
    await server.stop(true);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return server;
}

async function sessionResponse(producer: SessionProducer, request: Request) {
  const path = new URL(request.url).pathname;
  if (path === "/healthz" && request.method === "GET") return Response.json({ status: "ready" });
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (path === "/quiesce") {
    await producer.quiesce();
    return Response.json({ status: "quiesced" });
  }
  const body = await request.json();
  if (path === "/executions/accept")
    return Response.json(
      await producer.accept(
        z
          .object({
            acceptance: z.unknown(),
            conversationIdentity: z.unknown(),
            inputDirectory: z.string().optional(),
            priorMessages: z.array(PriorMessageSchema).optional(),
          })
          .parse(body),
      ),
    );
  const { execution, fingerprint } = Target.parse(body);
  if (path === "/executions/lookup") return Response.json(await producer.lookup(execution));
  if (!fingerprint) throw new Error("Fingerprint required");
  if (path === "/executions/cancel") return Response.json(await producer.cancel(execution, fingerprint));
  if (path === "/executions/ack") return Response.json(await producer.ack(execution, fingerprint));
  return new Response("Not found", { status: 404 });
}

function publishMessage(message: ConversationMessageInput) {
  try {
    process.stdout.write(`POCKETCODER_CONVERSATION ${JSON.stringify(message)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
  }
}
