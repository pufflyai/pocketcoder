import { runHarnessE2E } from "./contract";

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const key = process.env.POCKETCODER_KEY;
const template = process.env.POCKETCODER_EXAMPLE_TEMPLATE;
if (!key || !template) {
  throw new Error("POCKETCODER_KEY and POCKETCODER_EXAMPLE_TEMPLATE are required");
}

const report = await runHarnessE2E({
  baseUrl: process.env.POCKETCODER_URL ?? "http://127.0.0.1:7080",
  key,
  template,
  templateVersion: process.env.POCKETCODER_EXAMPLE_TEMPLATE_VERSION,
  prompt: process.env.POCKETCODER_EXAMPLE_PROMPT ?? "Reply with: pocketcoder example ok",
  expectedResponse: process.env.POCKETCODER_EXAMPLE_EXPECT,
  readyTimeoutMs: positiveInt("POCKETCODER_EXAMPLE_READY_TIMEOUT_MS", 120_000),
  messageTimeoutMs: positiveInt("POCKETCODER_EXAMPLE_MESSAGE_TIMEOUT_MS", 300_000),
});

console.log(JSON.stringify(report, null, 2));
