import { checkResume } from "./check";
import { startCheckModel } from "./check-model";
import { resumeInvocation } from "./launch";
import { ResumeSession } from "./session";
import { IsolatedStack } from "./stack";

const check = process.argv.includes("--check");
const idleFlag = process.argv.indexOf("--idle-seconds");
let idleSeconds = check ? 15 : 60;
if (idleFlag >= 0) idleSeconds = Number(process.argv[idleFlag + 1]);
const providerKey = process.env.OPENAI_API_KEY ?? "";
const providerModel = process.env.OPENAI_MODEL ?? "";
if (!Number.isInteger(idleSeconds) || idleSeconds < 10 || idleSeconds > 3600) {
  throw new Error("--idle-seconds must be between 10 and 3600");
}
if (!check && (!providerKey || !providerModel)) {
  throw new Error("Set OPENAI_API_KEY and OPENAI_MODEL in .env or your shell");
}

const stack = new IsolatedStack();
let child: ReturnType<typeof Bun.spawn> | undefined;
let closing: Promise<void> | undefined;
function close() {
  closing ??= (async () => {
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
    await stack.close();
  })();
  return closing;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close().finally(() => process.exit(130));
  });
}

try {
  const api = await stack.start(idleSeconds);
  const model = check ? startCheckModel() : undefined;
  if (model) stack.cleanups.push(async () => model.close());
  const session = new ResumeSession(
    api.client,
    {
      apiKey: check ? "isolated-test-upstream" : providerKey,
      allowedModel: check ? "resume-check" : providerModel,
      upstreamUrl: model?.url,
      expiresAt: api.expiresAt,
      maxOutputTokens: 4096,
      maxRequestBytes: 2 * 1024 * 1024,
      maxTotalRequestBytes: 32 * 1024 * 1024,
      maxRequests: 200,
      organization: process.env.OPENAI_ORGANIZATION,
      project: process.env.OPENAI_PROJECT,
    },
    check ? "openai-completions" : "openai-responses",
  );
  stack.cleanups.push(() => session.close());
  const workspace = await session.create();
  const control = session.controlServer();
  stack.cleanups.push(async () => control.close());
  const invocation = resumeInvocation({
    ...api,
    workspaceId: workspace.id,
    controlUrl: control.url,
    controlKey: control.key,
    check,
  });
  console.log(`Workspace ${workspace.id.slice(0, 8)} is ready.`);
  console.log(`Idle for ${idleSeconds}s to preserve, or type /preserve. The next message resumes.`);
  console.log(
    "Exit Pi to remove this isolated run, including its checkpoints. Session limit: 2 hours.",
  );
  if (model) {
    const rpc = Bun.spawn(invocation.command, {
      env: invocation.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child = rpc;
    await checkResume(rpc, session, model);
  } else {
    child = Bun.spawn(invocation.command, {
      env: invocation.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await child.exited;
    if (code !== 0) throw new Error(`Remote terminal exited with code ${code}`);
  }
} finally {
  await close();
}
