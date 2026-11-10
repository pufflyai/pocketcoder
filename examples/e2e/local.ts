import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PI_FIXTURE_CONTENT, PI_INTERRUPT_PROMPT, startFakePiGateway } from "../harnesses/pi/fake-gateway";
import { startOpenAIGateway } from "../harnesses/pi/openai-gateway";
import { localInputEnvironment } from "../local/input-environment";
import { startLeaseGateway } from "../local/lease-gateway";
import { LOCAL_PI_PRINCIPAL_SCOPES } from "../local/options";
import { buildLocalImage } from "../local/runtime";
import { imageSessionTemplate } from "../local/session-template";
import { bootstrapExampleOwner, issueExampleAccess } from "./administration";
import { runHarnessE2E } from "./contract";
import { runDoctorCheck } from "./doctor-check";
import { bestEffort, command, flag, freePort, waitFor } from "./local-process";

const ROOT = resolve(import.meta.dir, "../..");

const harness = flag("--harness") ?? "echo";
if (!["echo", "pi"].includes(harness)) {
  throw new Error("--harness must be echo or pi");
}
const useOpenAI = process.argv.includes("--openai");
const openAIApiKey = process.env.OPENAI_API_KEY;
const openAIModel = process.env.OPENAI_MODEL;
if (useOpenAI && harness !== "pi") {
  throw new Error("--openai requires --harness pi");
}
if (useOpenAI && (process.env.PI_GATEWAY_URL || process.env.PI_GATEWAY_MODEL)) {
  throw new Error("--openai cannot be combined with PI_GATEWAY_URL or PI_GATEWAY_MODEL");
}
if (useOpenAI && !openAIApiKey) {
  throw new Error("OPENAI_API_KEY is required with --openai");
}
if (useOpenAI && !openAIModel) {
  throw new Error("OPENAI_MODEL is required with --openai");
}
if (
  harness === "pi" &&
  !useOpenAI &&
  ((process.env.PI_GATEWAY_URL && !process.env.PI_GATEWAY_MODEL) ||
    (!process.env.PI_GATEWAY_URL && process.env.PI_GATEWAY_MODEL))
) {
  throw new Error("set both PI_GATEWAY_URL and PI_GATEWAY_MODEL, or neither to use the fake gateway");
}

const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const tempDir = await mkdtemp(resolve(tmpdir(), "pocketcoder-example-"));
const localImage = `pocketcoder-example-${harness}:${runId}`;
let serverProcess: ReturnType<typeof Bun.spawn> | null = null;
let modelGateway: ReturnType<typeof Bun.serve> | null = null;
let usesFakeGateway = false;
let leaseGateway: Awaited<ReturnType<typeof startLeaseGateway>> | undefined;

async function cleanup(): Promise<void> {
  await leaseGateway?.close();
  modelGateway?.stop(true);
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await Promise.race([serverProcess.exited, Bun.sleep(5000)]).catch(() => {});
  }
  await bestEffort(["docker", "image", "rm", "--force", localImage]);
  await rm(tempDir, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });
}

try {
  await command(["docker", "version", "--format", "{{.Server.Version}}"], { quiet: true });
  if (harness === "echo") {
    await command([
      "bun",
      "build",
      "packages/supervisor/src/index.ts",
      "--target",
      "bun",
      "--outdir",
      "deploy/image/dist",
    ]);
  }
  const { imageId } = await buildLocalImage({
    root: ROOT,
    imageTag: localImage,
    context: harness === "echo" ? "deploy/image" : ".",
    ...(harness === "pi" ? { dockerfile: "examples/harnesses/pi/Dockerfile" } : {}),
    command,
  });

  const template = await imageSessionTemplate(`${localImage}@${imageId}`, `${harness}-harness`);
  if (harness === "pi") {
    const hostBearer = randomBytes(24).toString("base64url");
    if (useOpenAI)
      modelGateway = startOpenAIGateway({
        apiKey: openAIApiKey!,
        clientBearer: hostBearer,
        allowedModel: openAIModel,
        organization: process.env.OPENAI_ORGANIZATION,
        project: process.env.OPENAI_PROJECT,
      });
    else if (!process.env.PI_GATEWAY_URL) {
      modelGateway = startFakePiGateway(hostBearer);
      usesFakeGateway = true;
    }
    leaseGateway = await startLeaseGateway({
      upstreamUrl: process.env.PI_GATEWAY_URL ?? `http://127.0.0.1:${modelGateway!.port}`,
      upstreamBearer: process.env.PI_GATEWAY_BEARER ?? hostBearer,
    });
    template.spec.security.writableMemoryPaths = ["/tmp", "/workspace", "/home/agent"];
    template.spec.services.session!.process!.cwd = "/workspace";
    template.spec.services.session!.process!.env = {
      HOME: "/home/agent",
      PI_GATEWAY_URL: `http://host.docker.internal:${leaseGateway.port}/v1`,
      PI_GATEWAY_MODEL: process.env.PI_GATEWAY_MODEL ?? (useOpenAI ? openAIModel! : "pocketcoder-test"),
      PI_GATEWAY_PROVIDER:
        process.env.PI_GATEWAY_PROVIDER ?? (useOpenAI ? "pocketcoder-openai" : "pocketcoder-gateway"),
      PI_GATEWAY_API: process.env.PI_GATEWAY_API ?? (useOpenAI ? "openai-responses" : "openai-completions"),
      PI_GATEWAY_BEARER_FILE: "credentialSlot:gateway",
      PI_CODING_AGENT_DIR: "/home/agent/.pi/agent",
      PI_WORKSPACE_DIR: "/workspace",
    };
    template.spec.credentialSlots.gateway = {
      policyRef: "pi-gateway",
      policyVersion: "1",
      binding: "fixed-scope",
      delivery: "workspace-expiring-file",
      maxLeaseSeconds: 7200,
    };
    await writeFile(resolve(tempDir, "issuer-ca.pem"), leaseGateway.ca);
  }
  const templateDir = resolve(tempDir, "templates");
  await mkdir(templateDir, { recursive: true });
  await writeFile(resolve(templateDir, `${harness}.json`), JSON.stringify(template, null, 2));

  const pepper = randomBytes(32).toString("base64url");
  const adminEnv = {
    POCKETCODER_DIR: resolve(tempDir, "pc_data"),
    POCKETCODER_AUTH_PEPPER: pepper,
  };
  const keyExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const ownerKey = await bootstrapExampleOwner(adminEnv.POCKETCODER_DIR, pepper, keyExpiry);

  const serverPort = freePort();
  const agentPort = freePort();
  serverProcess = Bun.spawn(["bun", "packages/server/src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...adminEnv,
      ...localInputEnvironment(tempDir),
      POCKETCODER_SECRET_KEY: randomBytes(32).toString("base64url"),
      POCKETCODER_ISSUER_CA_FILE: leaseGateway ? resolve(tempDir, "issuer-ca.pem") : undefined,
      // Linux containers reach the host through the Docker bridge gateway,
      // so the E2E server must listen beyond the host loopback interface.
      POCKETCODER_HOST: "0.0.0.0",
      POCKETCODER_PORT: String(serverPort),
      POCKETCODER_AGENT_HTTP: `0.0.0.0:${agentPort}`,
      POCKETCODER_TEMPLATE_DIR: templateDir,
      POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${agentPort}`,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  await waitFor(
    async () => {
      if (serverProcess?.exitCode !== null) {
        throw new Error(`pocketcoder-server exited with ${serverProcess?.exitCode}`);
      }
      return await fetch(`${baseUrl}/v1/openapi.json`)
        .then((response) => response.ok)
        .catch(() => false);
    },
    30_000,
    "pocketcoder-server",
  );

  if (leaseGateway) {
    const response = await fetch(baseUrl + "/v1/secrets/pi-gateway", {
      method: "PUT",
      headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "runtime-issuer", value: leaseGateway.config }),
    });
    if (!response.ok) throw new Error("Local gateway issuer configuration failed: " + (await response.text()));
  }

  const key = await issueExampleAccess(baseUrl, ownerKey, {
    name: `example-${runId}`,
    scopes: [...LOCAL_PI_PRINCIPAL_SCOPES],
    templates: ["*"],
    expiresAt: keyExpiry,
  });

  let defaultPrompt = "hello from the local E2E";
  if (harness === "echo") defaultPrompt = "hello from the local E2E";
  if (harness === "pi") {
    defaultPrompt =
      "Read /workspace/test.txt with the read tool. Reply with exactly the file contents and nothing else.";
  }
  const prompt = process.env.POCKETCODER_EXAMPLE_PROMPT ?? defaultPrompt;
  let expectedResponse = "";
  if (harness === "echo") expectedResponse = "echo: hello from the local E2E";
  if (harness === "pi") expectedResponse = usesFakeGateway ? PI_FIXTURE_CONTENT : "";
  if (harness === "pi") {
    const doctorOutput = await runDoctorCheck({ baseUrl, key, template: `${harness}-harness` }, (args, doctorEnv) =>
      command(args, { env: doctorEnv, quiet: true }),
    );
    console.log(doctorOutput);
    console.log("PocketCoder doctor passed against native Pi.");
  }
  const report = await runHarnessE2E({
    baseUrl,
    key,
    template: `${harness}-harness`,
    prompt,
    expectedResponse: process.env.POCKETCODER_EXAMPLE_EXPECT ?? (expectedResponse || undefined),
    expectedConversation:
      harness === "echo"
        ? [
            { role: "user", content: prompt },
            { role: "assistant", content: `echo: ${prompt}` },
          ]
        : undefined,
    readyTimeoutMs: harness === "echo" ? 120_000 : 300_000,
    messageTimeoutMs: harness === "echo" ? 60_000 : 600_000,
    expectedLiveUpdates: usesFakeGateway ? 2 : undefined,
    interruptPrompt: harness === "pi" && usesFakeGateway ? PI_INTERRUPT_PROMPT : undefined,
  });
  console.log("PocketCoder local harness E2E passed:");
  console.log(JSON.stringify(report, null, 2));
  if (harness === "pi" && usesFakeGateway) {
    await command(["bun", "test", "examples/harnesses/pi/session-replies.test.ts"], {
      env: { POCKETCODER_PI_TEST_URL: baseUrl, POCKETCODER_PI_TEST_KEY: key },
    });
    console.log("Pi repeated-reply regression passed: four stable and durable file replies.");
  }
} finally {
  await cleanup();
}
