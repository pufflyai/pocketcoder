import { startCheckModel } from "./check-model";
import { requiredEnvironment } from "./environment";
import { ResumeSession } from "./session";
import type { IsolatedStack } from "./stack";

export async function startSession(stack: IsolatedStack, idleSeconds: number, check: boolean) {
  const api = await stack.start(idleSeconds);
  const model = check ? startCheckModel() : undefined;
  if (model) stack.cleanups.push(async () => model.close());
  const session = new ResumeSession(
    api.client,
    {
      apiKey: check ? "isolated-test-upstream" : requiredEnvironment("OPENAI_API_KEY"),
      allowedModel: check ? "resume-check" : requiredEnvironment("OPENAI_MODEL"),
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
  console.log("Starting the Pi workspace...");
  const workspace = await session.create();
  return { api, model, session, workspace };
}
