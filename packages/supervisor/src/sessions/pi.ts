import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { jsonLines } from "./json-lines";
import { PiEvents } from "./pi-events";
import type { SessionRun, SessionRunner } from "./producer";
import { sessionEnvironment } from "./session-env";

// Pi owns model context in its session file. PocketCoder owns the public messages.
export function piRunner(command: string[], directory: string): SessionRunner {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return async (run) => {
    run.signal.throwIfAborted();
    const session = join(directory, `${run.identity.conversation_id}.jsonl`);
    const child = Bun.spawn([...command, "--mode", "rpc", "--session", session], {
      env: {
        ...sessionEnvironment(process.env, run.identity.conversation_id),
        POCKETCODER_CONVERSATION_ID: run.identity.conversation_id,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      detached: true,
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), 5000);
      try {
        child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
        child.stdin.flush();
      } catch {
        killGroup(child.pid, "SIGTERM");
      }
    };
    run.signal.addEventListener("abort", abort, { once: true });
    const files = run.acceptance.inputs.objects.map((file) => `${run.inputDirectory}/${file.fileId} (${file.name})`);
    const message =
      String(run.acceptance.input.message) +
      (files.length ? `\n\nRead these immutable input files:\n${files.join("\n")}` : "");
    try {
      child.stdin.write(`${JSON.stringify({ id: run.identity.request_id, type: "prompt", message })}\n`);
      await child.stdin.flush();
      const events = await settle(child.stdout, run);
      if (events.aborted) return "canceled";
    } finally {
      run.signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
      try {
        child.stdin.end();
      } catch {
        /* A closed RPC pipe must not prevent process-group cleanup. */
      }
      killGroup(child.pid, "SIGTERM");
      const timer = setTimeout(() => killGroup(child.pid, "SIGKILL"), 5000);
      await child.exited;
      killGroup(child.pid, "SIGKILL");
      clearTimeout(timer);
    }
  };
}

function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL") {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function settle(stream: ReadableStream<Uint8Array>, run: SessionRun) {
  const events = new PiEvents();
  for await (const raw of jsonLines(stream)) {
    const update = events.receive(raw);
    if (update) run.emit(update.key, update.role, update.parts);
    if (events.failure && (events.commandFailed || events.settled)) throw new Error(events.failure);
    if (events.settled) break;
  }
  if (!events.settled) throw new Error("Pi exited before the turn settled");
  if (events.finalMessage)
    run.emit(events.finalMessage.key, "assistant", events.finalMessage.parts, { type: "final_response" });

  return events;
}
