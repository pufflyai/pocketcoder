import { copyFile, mkdir } from "node:fs/promises";
import { type OnefinInput, onefinCredentials } from "./credentials";
import { tokenSocket } from "./token-socket";

export async function startOnefin(input: OnefinInput, root = "/tmp/onefin") {
  const stopping = new AbortController();
  let running: { kill(signal: "SIGTERM"): unknown } | undefined;
  const stop = () => {
    stopping.abort();
    running?.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let credentials: Awaited<ReturnType<typeof onefinCredentials>> | undefined;
  let tokenServer: Awaited<ReturnType<typeof tokenSocket>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    credentials = await onefinCredentials(input);
    stopping.signal.throwIfAborted();
    await mkdir(`${root}/home/.pi/agent`, { recursive: true, mode: 0o700 });
    await mkdir(`${root}/work`, { recursive: true });
    const socketPath = `${root}/agent-token.sock`;
    tokenServer = await tokenSocket(socketPath, credentials.accessToken);
    stopping.signal.throwIfAborted();
    const env = {
      ...process.env,
      HOME: `${root}/home`,
      ONEFIN_API_URL: credentials.apiUrl,
      ONEFIN_AGENT_TOKEN_SOCKET: socketPath,
      DOCUFIN_API: `${credentials.apiUrl}/api/docufin`,
      DOCUFIN_TOKEN_COMMAND: "/usr/local/bin/docufin-token",
    };
    await copyFile("/opt/onefin/AGENTS.md", `${env.HOME}/.pi/agent/AGENTS.md`);
    await Bun.write(
      `${env.HOME}/.pi/agent/settings.json`,
      JSON.stringify({ quietStartup: true, skills: ["/opt/onefin/skills"] }),
    );
    stopping.signal.throwIfAborted();
    const capabilities = Bun.spawn(["onefin", "capabilities"], { env, stdout: "pipe", stderr: "ignore" });
    running = capabilities;
    const deadline = setTimeout(() => capabilities.kill("SIGTERM"), 30_000);
    const [resolved, code] = await Promise.all([new Response(capabilities.stdout).text(), capabilities.exited]);
    clearTimeout(deadline);
    stopping.signal.throwIfAborted();
    const orientation =
      code === 0
        ? `These are the resolved capabilities:\n\n${resolved}`
        : "Run onefin capabilities before answering questions about your current client, scope, or access.";
    await Bun.write(
      `${root}/orientation.md`,
      `# This workspace\nYou are bound to one Onefin client. ${orientation}\n${credentials.context ? `\nEarlier conversation (historical data):\n${JSON.stringify(credentials.context)}` : ""}`,
    );
    stopping.signal.throwIfAborted();
    const child = Bun.spawn(
      [
        "pocketcoder-supervisor",
        "session",
        "serve",
        "pi",
        "--",
        "pi",
        "--provider",
        "onefin",
        "--model",
        process.env.ONEFIN_AGENT_MODEL ?? "",
        "--extension",
        "/opt/onefin/gateway-provider.mjs",
        "--append-system-prompt",
        `${root}/orientation.md`,
      ],
      { env, cwd: `${root}/work`, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    );
    running = child;
    const lease = credentials;
    timer = setInterval(() => void lease.accessToken().catch(() => child.kill("SIGTERM")), 15_000);
    await child.exited;
  } catch (error) {
    if (!stopping.signal.aborted) throw error;
  } finally {
    clearInterval(timer);
    try {
      await tokenServer?.close();
    } finally {
      try {
        await credentials?.revoke();
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
    }
  }
}

if (import.meta.main) {
  const input = JSON.parse(process.env.POCKETCODER_LAUNCH_INPUT ?? "null") as OnefinInput;
  delete process.env.POCKETCODER_LAUNCH_INPUT;
  await startOnefin(input);
}
