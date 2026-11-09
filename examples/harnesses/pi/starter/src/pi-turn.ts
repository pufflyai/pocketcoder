import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { BEARER_ENV, type ModelRoute, PROVIDER } from "./model-route";

export interface TurnInput {
  // Pi's CLI module, run with the same Bun that runs the adapter.
  piCli: string;
  agentDir: string;
  sessionDir: string;
  // The logical session (conversation) ID. Pi keeps its history across this session's turns.
  sessionId: string;
  cwd: string;
  prompt: string;
  outputDir: string;
  route: ModelRoute;
  bearer: string;
}

export interface TurnResult {
  status: "completed" | "failed" | "canceled";
  reasonCode: string | null;
  finalResponse: string | null;
}

type PiMessage = { role?: string; content?: { type: string; text?: string }[]; stopReason?: string };

const textOf = (message: PiMessage | null) => {
  const text = message?.content?.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
  return text || null;
};

// Pi's JSON mode reports each assistant message and the end of the run as structured events.
// The outcome comes from those events and the stop reason, never from parsing terminal text.
function outcome(last: PiMessage | null, ended: boolean, aborted: boolean): TurnResult {
  const finalResponse = textOf(last);
  if (aborted) return { status: "canceled", reasonCode: "canceled_by_request", finalResponse };
  if (!ended) return { status: "failed", reasonCode: "producer_exited", finalResponse };
  if (last?.stopReason === "aborted") return { status: "canceled", reasonCode: "agent_aborted", finalResponse };
  if (last?.stopReason === "error") return { status: "failed", reasonCode: "model_error", finalResponse };
  return { status: "completed", reasonCode: null, finalResponse };
}

// One Pi run per accepted turn, in its own process group so a targeted cancel also stops the
// tools it started. Other turns and sessions keep running.
export function startTurn(input: TurnInput) {
  const args = [
    "--provider",
    PROVIDER,
    "--model",
    input.route.model,
    "--mode",
    "json",
    "--print",
    "--session-dir",
    input.sessionDir,
    "--session-id",
    input.sessionId,
    "--append-system-prompt",
    `Save every file you want to return to the user in ${input.outputDir}. Files saved elsewhere are not returned.`,
    "--approve",
    "--offline",
    input.prompt,
  ];
  const child = spawn(process.execPath, [input.piCli, ...args], {
    cwd: input.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_CODING_AGENT_DIR: input.agentDir, [BEARER_ENV]: input.bearer },
  });
  let last: PiMessage | null = null;
  let ended = false;
  let aborted = false;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event: { type?: string; message?: PiMessage };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") last = event.message;
    if (event.type === "agent_end") ended = true;
  });
  child.stderr.resume();
  const result = new Promise<TurnResult>((resolve) => {
    child.on("close", () => resolve(outcome(last, ended, aborted)));
    child.on("error", () => resolve(outcome(last, false, aborted)));
  });
  return {
    result,
    abort() {
      if (child.exitCode !== null || child.pid === undefined) return;
      aborted = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The group already exited; the close event reports the outcome.
      }
    },
  };
}
