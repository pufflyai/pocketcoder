import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { Subprocess } from "bun";
import { waitFor } from "../e2e/local-process";

export function checkClient(child: Subprocess<"pipe", "pipe", "pipe">) {
  const events: Array<Record<string, unknown>> = [];
  const lines = createInterface({ input: Readable.fromWeb(child.stdout) });
  lines.on("line", (line) => {
    if (line.startsWith("{")) events.push(JSON.parse(line));
  });
  const stderr = new Response(child.stderr).text();
  async function send(message: string) {
    child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
    await child.stdin.flush();
  }
  async function until(predicate: () => boolean, label: string) {
    await waitFor(
      async () => {
        if (child.exitCode !== null) throw new Error(`Client exited: ${await stderr}`);
        const error = events.find((event) => event.type === "response" && event.success === false);
        if (error) throw new Error(JSON.stringify(error));
        return predicate();
      },
      120_000,
      label,
    );
  }
  return {
    events,
    child,
    until,
    async entries() {
      const id = crypto.randomUUID();
      child.stdin.write(`${JSON.stringify({ type: "get_entries", id })}\n`);
      await child.stdin.flush();
      await until(() => events.some((event) => event.id === id), "session entries");
      const response = events.find((event) => event.id === id);
      return response?.data as {
        entries: Array<{
          type: string;
          customType?: string;
          data?: { content?: string; role?: string };
        }>;
      };
    },
    async prompt(message: string, expected: string) {
      const start = events.length;
      await send(message);
      await until(() => events.slice(start).some((event) => event.type === "agent_settled"), "remote turn");
      if (!JSON.stringify(events.slice(start)).includes(expected)) throw new Error(`Missing response: ${expected}`);
    },
    async quit() {
      await send("/quit");
      await waitFor(async () => child.exitCode !== null, 120_000, "quit and preserve");
      if ((await child.exited) !== 0) throw new Error(`Quit failed: ${await stderr}`);
    },
    async close() {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
      lines.close();
      await stderr;
    },
  };
}
