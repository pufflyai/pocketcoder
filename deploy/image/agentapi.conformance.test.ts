import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

const image = process.env.POCKETCODER_AGENTAPI_CONFORMANCE_IMAGE;
const fixture = `
process.stdout.write('Ready\\n> ');
for await (const line of console) {
  process.stdout.write('Done.\\n> ');
}
`;

async function docker(...args: string[]) {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code) throw new Error(`docker failed: ${error}`);
  return output.trim();
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`AgentAPI did not ${label}`);
}

// PC-121, 2026-10-14: the image smoke runs this against the installed binary;
// ordinary host tests have no AgentAPI image or model-provider dependency.
test.skipIf(!image)(
  "installed AgentAPI settles two identical answers as separate turns",
  async () => {
    const name = `pc-agentapi-${randomUUID()}`;
    await docker(
      "run",
      "--detach",
      "--name",
      name,
      "--publish",
      "127.0.0.1::3284",
      "--entrypoint",
      "agentapi",
      image as string,
      "server",
      "--port",
      "3284",
      "--type",
      "custom",
      "--",
      "bun",
      "-e",
      fixture,
    );
    try {
      const port = (await docker("port", name, "3284/tcp")).split(":").at(-1);
      const base = `http://127.0.0.1:${port}`;
      const stable = async () => {
        try {
          return (await (await fetch(`${base}/status`)).json()).status === "stable";
        } catch {
          return false;
        }
      };
      await waitFor(stable, "become ready");
      let replies = 0;
      for (const prompt of ["first turn", "second turn"]) {
        const response = await fetch(`${base}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "user", content: prompt }),
        });
        expect(response.status).toBe(200);
        replies += 1;
        await waitFor(async () => {
          const body = (await (await fetch(`${base}/messages`)).json()) as {
            messages: { role: string; content: string }[];
          };
          return (
            body.messages.filter((message) => message.role === "agent" && message.content.includes("Done.")).length ===
            replies
          );
        }, `record ${prompt}`);
        await waitFor(stable, `settle ${prompt}`);
      }
      const body = (await (await fetch(`${base}/messages`)).json()) as {
        messages: { role: string; content: string }[];
      };
      expect(
        body.messages.filter((message) => message.role === "agent" && message.content.includes("Done.")),
      ).toHaveLength(2);
    } finally {
      await docker("rm", "--force", "--volumes", name);
    }
  },
  40_000,
);
