import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { Subprocess } from "bun";
import { waitFor } from "../e2e/local-process";
import type { startCheckModel } from "./check-model";
import type { ResumeSession } from "./session";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function checkResume(
  child: Subprocess<"pipe", "pipe", "pipe">,
  session: ResumeSession,
  model: ReturnType<typeof startCheckModel>,
) {
  let settled = 0;
  let output = "";
  let stderr = "";
  let errors: string[] = [];
  const lines = createInterface({ input: Readable.fromWeb(child.stdout) });
  lines.on("line", (line) => {
    const event = JSON.parse(line) as {
      type: string;
      messages?: unknown;
      success?: boolean;
      error?: string;
    };
    if (event.type === "agent_end") output += JSON.stringify(event.messages);
    if (event.type === "agent_settled") settled += 1;
    if (event.type === "response" && event.success === false) errors.push(event.error ?? line);
  });
  const errorOutput = new Response(child.stderr).text().then((text) => {
    stderr = text;
  });
  async function prompt(message: string, expected: string) {
    const previous = settled;
    output = "";
    errors = [];
    child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
    await child.stdin.flush();
    await waitFor(
      async () => {
        if (child.exitCode !== null) {
          await errorOutput;
          throw new Error(`Remote client exited: ${stderr}`);
        }
        if (errors.length) throw new Error(errors.join("\n"));
        return settled > previous;
      },
      120_000,
      "remote turn",
    );
    assert(output.includes(expected), `Expected ${expected} in response: ${output}`);
  }

  const token = `RESUME-${randomUUID()}`;
  try {
    await prompt(`Save token ${token}`, "Saved.");
    const first = session.generations[0];
    assert(first, "Expected workspace generation 0");
    console.log("Saved the marker file; waiting for automatic idle preservation...");
    await waitFor(
      async () => (await session.client.workspaces.get(first.id)).state === "preserved",
      120_000,
      "idle preservation",
    );
    const oldGateway = session.gateways[0];
    assert(oldGateway, "Expected original gateway");
    const revoked = await fetch(`${oldGateway.localUrl}/health`, {
      headers: { authorization: `Bearer ${oldGateway.bearer}` },
    });
    assert(revoked.status === 410, "The old workspace gateway must be revoked");
    await prompt("Read the saved file.", token);
    assert(session.generations.length === 2, "First turn must resume exactly once");
    const second = session.generations[1];
    assert(second, "Expected workspace generation 1");
    assert(second.origin_workspace_id === first.id, "First resume lineage must match");
    assert(oldGateway.bearer !== session.gateways[1]?.bearer, "Resume must rotate the bearer");
    await session.preserve(second.id);
    await prompt("Recall the original token from our conversation.", token);
    assert(Number(session.generations.length) === 3, "Second turn must resume exactly once");
    const third = session.generations[2];
    assert(third, "Expected workspace generation 2");
    assert(third.origin_workspace_id === second.id, "The terminal must follow the new workspace");
    await prompt("Read the saved file again.", token);
    assert(Number(session.generations.length) === 3, "A ready workspace must not resume again");
    assert(
      model.prompts.filter((p) => p === "Read the saved file.").length === 1,
      "Never replay an accepted prompt",
    );
    assert(
      model.prompts.filter((p) => p === "Recall the original token from our conversation.")
        .length === 1,
      "Never duplicate a resumed prompt",
    );
    console.log(
      "Resume check passed: idle preserve, two resumes, file and model context, fresh credentials, no replay.",
    );
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    lines.close();
    await errorOutput;
  }
}
