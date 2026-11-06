import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// A credential-free reference producer. It reads the same immutable input
// projection a coding agent receives, and reports the bytes it actually saw.
const directory = "/tmp/pocketcoder-file-agent";
await mkdir(directory, { recursive: true, mode: 0o700 });
type Execution = { requestId: string; workspaceId: string; incarnationId: string; owner: string };
type Receipt = {
  execution: Execution;
  fingerprint: string;
  phase: "accepted" | "terminal" | "canceled";
  outcome: unknown;
};
async function saved(id: string): Promise<Receipt | null> {
  try {
    return JSON.parse(await readFile(join(directory, `${id}.json`), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function persist(receipt: Receipt) {
  const path = join(directory, `${receipt.execution.requestId}.json`);
  const stage = `${path}.new`;
  await writeFile(stage, JSON.stringify(receipt), { mode: 0o600 });
  await rename(stage, path);
}
async function answer(content: string, inputDirectory?: string) {
  const manifest = inputDirectory ? await Bun.file(join(inputDirectory, "manifest.json")).json() : { objects: [] };
  const files: { name: string; sizeBytes: number; digest: string; text: string | null }[] = [];
  for (const object of manifest.objects) {
    if (!inputDirectory) throw new Error("Input directory missing");
    const bytes = await Bun.file(join(inputDirectory, object.fileId)).bytes();
    files.push({
      name: object.name,
      sizeBytes: bytes.length,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      text: object.mediaType?.startsWith("text/") ? new TextDecoder().decode(bytes) : null,
    });
  }
  return {
    content: [
      `echo: ${content}`,
      ...files.map((file) => `${file.name}: ${file.text ?? `${file.sizeBytes} bytes (${file.digest})`}`),
    ].join("\n"),
    files,
  };
}

let pending = Promise.resolve();
Bun.serve({
  hostname: "127.0.0.1",
  port: 3284,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/status") return Response.json({ status: "stable" });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = (await request.json()) as {
      acceptance?: { execution: Execution; fingerprint: string; input: { content: string } };
      execution: Execution;
      fingerprint: string;
      inputDirectory?: string;
    };
    const execution: Execution = body.acceptance?.execution ?? body.execution;
    if (!execution || !/^[0-9a-f-]{36}$/.test(execution.requestId)) return new Response(null, { status: 400 });
    if (path === "/executions/ack") return Response.json({ ok: true });
    let result: Response | undefined;
    const task = pending.then(async () => {
      const receipt = await saved(execution.requestId);
      if (receipt) {
        if (body.acceptance && receipt.fingerprint !== body.acceptance.fingerprint)
          result = new Response(null, { status: 409 });
        else result = Response.json(receipt);
        return;
      }
      if (path === "/executions/lookup") {
        result = Response.json({ execution, phase: "absent" });
        return;
      }
      if (path === "/executions/cancel") {
        const canceled: Receipt = { execution, fingerprint: body.fingerprint, phase: "canceled", outcome: null };
        await persist(canceled);
        result = Response.json(canceled);
        return;
      }
      if (path !== "/executions/accept") {
        result = new Response(null, { status: 404 });
        return;
      }
      const acceptance = body.acceptance;
      if (!acceptance) {
        result = new Response(null, { status: 400 });
        return;
      }
      const accepted: Receipt = {
        execution,
        fingerprint: acceptance.fingerprint,
        phase: "accepted",
        outcome: null,
      };
      await persist(accepted);
      const outcome = await answer(acceptance.input.content, body.inputDirectory);
      const terminal: Receipt = { ...accepted, phase: "terminal", outcome };
      await persist(terminal);
      result = Response.json(terminal);
    });
    pending = task.catch(() => {});
    await task;
    return result ?? new Response(null, { status: 500 });
  },
});
