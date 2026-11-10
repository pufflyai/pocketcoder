import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ModelRoute, readBearer, routeFromEnv, writeModelConfig } from "./model-route";
import { startTurn, type TurnResult } from "./pi-turn";
import { collectPublication } from "./publication";

export interface AdapterConfig {
  piCli: string;
  agentDir: string;
  sessionDir: string;
  workspaceDir: string;
  outputRoot: string;
  maxPublicationBytes: number;
  route: ModelRoute;
}

type Execution = { workspaceId: string; incarnationId: string; owner: string; requestId: string };
type Fact = {
  execution: Execution;
  fingerprint: string;
  phase: "running" | "terminal" | "canceled";
  outcome: Record<string, unknown> | null;
  publication?: Awaited<ReturnType<typeof collectPublication>>;
};
interface Turn {
  fact: Fact;
  abort?: () => void;
  settled?: Promise<void>;
}

// One envelope type covers every action; each action reads only its own fields.
type Envelope = {
  acceptance?: { execution: Execution; fingerprint: string; input?: { message?: unknown } };
  conversationIdentity?: { conversation_id: string } | null;
  inputDirectory?: string;
  execution: Execution;
  fingerprint: string;
};

const refuse = (status: number, message: string) => new Response(message, { status });

// pocketcoder.execution/v1 for the Pi producer. Facts live only as long as this workspace
// service: the controller owns durable request state, deduplication and recovery, so a
// restarted adapter answers `absent` and the controller keeps the outcome uncertain.
export function createExecutionAdapter(config: AdapterConfig) {
  const turns = new Map<string, Turn>();

  async function prompt(message: string, inputDirectory: string | undefined) {
    if (!inputDirectory) return message;
    const manifest = JSON.parse(await readFile(join(inputDirectory, "manifest.json"), "utf8")) as {
      objects: { fileId: string; name: string }[];
    };
    const files = manifest.objects.map((object) => `- ${object.name}: ${join(inputDirectory, object.fileId)}`);
    return `${message}\n\nAttached files (read-only):\n${files.join("\n")}`;
  }

  async function finish(turn: Turn, turnId: string, outputDir: string, result: TurnResult, startedAt: string) {
    const publication = await collectPublication(
      turnId,
      outputDir,
      config.maxPublicationBytes,
      result.status === "completed",
    );
    turn.fact = {
      ...turn.fact,
      phase: result.status === "canceled" ? "canceled" : "terminal",
      outcome: {
        status: result.status,
        ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
        finalResponse: result.finalResponse,
        startedAt,
      },
      publication,
    };
  }

  async function accept(body: Envelope) {
    const acceptance = body.acceptance;
    if (!acceptance) return refuse(400, "Missing acceptance.");
    const turnId = acceptance.execution.requestId;
    const known = turns.get(turnId);
    if (known) {
      if (known.fact.fingerprint !== acceptance.fingerprint) return refuse(409, "Request identity changed.");
      return Response.json(known.fact);
    }
    const message = acceptance.input?.message;
    const sessionId = body.conversationIdentity?.conversation_id;
    if (typeof message !== "string" || !sessionId) return refuse(400, "Pi turns need a message and a session.");
    const outputDir = join(config.outputRoot, turnId);
    await mkdir(outputDir, { recursive: true });
    const startedAt = new Date().toISOString();
    const turn: Turn = {
      fact: {
        execution: acceptance.execution,
        fingerprint: acceptance.fingerprint,
        phase: "running",
        outcome: { startedAt },
      },
    };
    turns.set(turnId, turn);
    let bearer: string;
    try {
      bearer = await readBearer(config.route);
    } catch {
      await finish(
        turn,
        turnId,
        outputDir,
        { status: "failed", reasonCode: "model_credential_unavailable", finalResponse: null },
        startedAt,
      );
      return Response.json(turn.fact);
    }
    const run = startTurn({
      piCli: config.piCli,
      agentDir: config.agentDir,
      sessionDir: config.sessionDir,
      sessionId,
      cwd: config.workspaceDir,
      prompt: await prompt(message, body.inputDirectory),
      outputDir,
      route: config.route,
      bearer,
    });
    turn.abort = run.abort;
    turn.settled = run.result.then((result) => finish(turn, turnId, outputDir, result, startedAt));
    return Response.json(turn.fact);
  }

  async function cancel(body: Envelope) {
    const turnId = body.execution.requestId;
    const turn = turns.get(turnId);
    if (!turn) {
      // Never started here: record the cancel so a late accept cannot start it.
      const fact: Fact = { execution: body.execution, fingerprint: body.fingerprint, phase: "canceled", outcome: null };
      turns.set(turnId, { fact });
      return Response.json(fact);
    }
    if (turn.fact.phase === "running") {
      turn.abort?.();
      await turn.settled;
    }
    return Response.json(turn.fact);
  }

  return {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/status") return Response.json({ status: "stable" });
      if (request.method !== "POST") return refuse(404, "Not found.");
      const body = (await request.json()) as Envelope;
      if (path === "/executions/accept") return accept(body);
      if (path === "/executions/cancel") return cancel(body);
      const turn = turns.get(body.execution?.requestId);
      if (path === "/executions/lookup")
        return Response.json(turn?.fact ?? { execution: body.execution, phase: "absent" });
      // The controller committed the terminal fact; the record stays readable for replays.
      if (path === "/executions/ack") return turn ? Response.json({ ok: true }) : refuse(404, "Unknown execution.");
      return refuse(404, "Not found.");
    },
    // Lets tests and shutdown wait for runs to settle.
    settled: () => Promise.all([...turns.values()].map((turn) => turn.settled)),
    stop: () => {
      for (const turn of turns.values()) turn.abort?.();
    },
  };
}

export async function configFromEnv(env: Record<string, string | undefined>): Promise<AdapterConfig> {
  const maxPublicationBytes = Number(env.PI_PUBLICATION_MAX_BYTES);
  if (!Number.isSafeInteger(maxPublicationBytes) || maxPublicationBytes <= 0)
    throw new Error("PI_PUBLICATION_MAX_BYTES must be a positive integer");
  const config: AdapterConfig = {
    piCli: env.PI_CLI ?? "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    agentDir: env.PI_CODING_AGENT_DIR ?? "/home/agent/.pi/agent",
    sessionDir: env.PI_SESSION_DIR ?? "/home/agent/.pi/sessions",
    workspaceDir: env.PI_WORKSPACE_DIR ?? "/workspace",
    outputRoot: env.PI_OUTPUT_ROOT ?? "/workspace/.pocketcoder/outputs",
    maxPublicationBytes,
    route: routeFromEnv(env),
  };
  await writeModelConfig(config.agentDir, config.route);
  return config;
}

if (import.meta.main) {
  const port = Number(process.env.PI_ADAPTER_PORT);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error("PI_ADAPTER_PORT must be a port number");
  const adapter = createExecutionAdapter(await configFromEnv(process.env));
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: adapter.fetch });
  const shutdown = () => {
    adapter.stop();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
