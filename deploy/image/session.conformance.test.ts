import { expect, test } from "bun:test";
import { digestOf, ProducerObservationSchema } from "@pstdio/pocketcoder-contracts";

const image = process.env.POCKETCODER_SESSION_CONFORMANCE_IMAGE;
const command = async (args: string[]) => {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(err);
  return out.trim();
};

test.skipIf(!image)(
  "installed native producer preserves identical replies, identities and literal markup",
  async () => {
    const name = `pc-session-${crypto.randomUUID()}`;
    try {
      await command([
        "docker",
        "run",
        "--detach",
        "--rm",
        "--name",
        name,
        "--publish",
        "127.0.0.1::3285",
        "--entrypoint",
        "bun",
        image!,
        "-e",
        `Bun.spawn(['bun','/opt/pocketcoder/supervisor.js','session','serve','echo'],{stdout:'inherit',stderr:'inherit'});Bun.serve({hostname:'0.0.0.0',port:3285,fetch:request=>fetch(new Request('http://127.0.0.1:3284'+new URL(request.url).pathname,request))});`,
      ]);
      const mapping = await command(["docker", "port", name, "3285/tcp"]);
      const base = `http://${mapping}`;
      const deadline = Date.now() + 30_000;
      while (
        !(await fetch(base + "/healthz")
          .then((r) => r.ok)
          .catch(() => false))
      ) {
        if (Date.now() > deadline) throw new Error("Producer did not start");
        await Bun.sleep(50);
      }
      const conversation_id = crypto.randomUUID();
      const ids = new Set<string>();
      const text = "**å**\n<ot>literal</ot>";
      for (let turn = 0; turn < 4; turn++) {
        const execution = {
          workspaceId: crypto.randomUUID(),
          incarnationId: "test",
          owner: "conversation-request",
          requestId: crypto.randomUUID(),
        };
        const inputs = { workspaceId: execution.workspaceId, incarnationId: "test", objects: [] };
        const facts = {
          execution,
          callerPrincipalId: crypto.randomUUID(),
          templateDigest: digestOf("template"),
          adapterDigest: digestOf("adapter"),
          operation: "message",
          input: { message: text },
          inputs: { ...inputs, digest: digestOf(inputs) },
          bindingSetDigest: digestOf([]),
        };
        const acceptance = { ...facts, fingerprint: digestOf(facts) };
        const conversationIdentity = {
          schema: "pocketcoder.conversation/v2",
          authority: "external",
          conversation_id,
          request_id: crypto.randomUUID(),
          turn_id: execution.requestId,
          request_fingerprint: acceptance.fingerprint.slice(7),
        };
        const post = async (path: string, body: unknown) => {
          const response = await fetch(base + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(await response.text());
          return ProducerObservationSchema.parse(await response.json());
        };
        let snapshot = await post("/executions/accept", { acceptance, conversationIdentity });
        while (snapshot.phase !== "terminal") {
          snapshot = await post("/executions/lookup", { execution });
          if (Date.now() > deadline) throw new Error("Turn did not settle");
          await Bun.sleep(10);
        }
        const reply = snapshot.messages?.find((m) => m.identity?.fact?.type === "final_response");
        expect(reply?.parts).toEqual([{ type: "text", text: `echo: ${text}` }]);
        expect(reply).toBeDefined();
        ids.add(reply!.message_id);
        expect(await post("/executions/accept", { acceptance, conversationIdentity })).toEqual(snapshot);
      }
      expect(ids.size).toBe(4);
    } finally {
      await command(["docker", "rm", "--force", name]).catch(() => {});
    }
  },
  60_000,
);
