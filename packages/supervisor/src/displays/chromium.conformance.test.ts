import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chromium } from "./chromium";
import { browserPort } from "./chromium-startup.fixture";

const executable =
  process.env.POCKETCODER_CHROMIUM_BINARY ??
  Bun.which("chromium") ??
  Bun.which("google-chrome") ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) throw new Error("Chromium did not become ready.");
    await Bun.sleep(25);
  }
}

async function connect(profile: string, child: Bun.Subprocess) {
  const port = await browserPort(profile, child, executable);
  const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const target = targets.find((entry) => entry.type === "page");
  if (!target) throw new Error("Chromium page is missing.");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const client = new Chromium(
    socket,
    () => {},
    () => {},
  );
  await until(
    async () => socket.readyState,
    (state) => state === WebSocket.OPEN,
  );
  await client.command("Page.enable");
  return client;
}

async function inspect(client: Chromium, expression: string) {
  const response = await client.command("Runtime.evaluate", { expression, returnByValue: true });
  return (response.result as { value: unknown }).value;
}

async function navigate(client: Chromium, url: string) {
  await client.action({ action: "navigate", url });
  await until(
    () =>
      inspect(
        client,
        `location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && Boolean(document.querySelector('textarea'))`,
      ),
    (ready) => ready === true,
  );
}

test("Enter submits forms and inserts a textarea newline in real Chromium", async () => {
  // Load the installed executable without retaining it; cold Linux page I/O can stall startup.
  let executableBytes = 0;
  for await (const chunk of Bun.file(executable).stream()) executableBytes += chunk.byteLength;
  console.log(`Browser fixture: loaded ${executableBytes} executable bytes.`);
  const profile = await mkdtemp(join(tmpdir(), "pocketcoder-chromium-"));
  let submitted = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/submitted") submitted++;
      return new Response(
        `<!doctype html><style>body{margin:0}input{position:absolute;left:0;top:0;width:300px;height:40px}
        textarea{position:absolute;left:0;top:100px;width:300px;height:100px}</style>
        <form action="/submitted"><input name="q"></form><textarea></textarea>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const process = Bun.spawn(
    [
      executable,
      "--headless",
      "--no-first-run",
      "--disable-background-networking",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  let client: Chromium | undefined;
  try {
    client = await connect(profile, process);
    await navigate(client, server.url.href);
    await client.action({ action: "click", x: 100, y: 125 });
    await client.action({ action: "text", text: "before" });
    await client.action({ action: "key", key: "Enter" });
    await client.action({ action: "text", text: "after" });
    expect(await inspect(client, "document.querySelector('textarea').value")).toBe("before\nafter");
    await navigate(client, `${server.url.href}?form`);
    await client.action({ action: "click", x: 100, y: 25 });
    await client.action({ action: "text", text: "hello" });
    await client.action({ action: "key", key: "Enter" });
    await until(
      async () => submitted,
      (value) => value > 0,
    );
    expect(submitted).toBe(1);
  } finally {
    client?.close();
    await server.stop(true);
    process.kill("SIGTERM");
    await Promise.race([process.exited, Bun.sleep(1000)]);
    if (process.exitCode === null) process.kill("SIGKILL");
    await process.exited;
    await rm(profile, { recursive: true, force: true });
  }
}, 15_000);
