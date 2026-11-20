import { defineCommand, params } from "@pstdio/sdk/extensions";
import { startCollection } from "./commands";
import { projectRoot, runDeps } from "./context";
import { collectQualification, readQualification, startQualification } from "./qualification";
export const qualify = defineCommand({
  id: "qualify",
  title: "Qualify all required hosts",
  mutating: true,
  cli: { description: "Run the candidate's full qualification on each configured host; keep missing workers visible." },
  params: {
    path: params.text({ label: "Repository folder" }),
    ref: params.text({ label: "Candidate Git ref" }),
    sessionId: params.text({ label: "Starting session" }),
  },
  async run(ctx, input) {
    const suite = await startQualification(
      { ...(await runDeps(ctx)), onStarted: (record) => startCollection(ctx, record.runId) },
      { root: input.path || (await projectRoot(ctx)), ref: input.ref, sessionId: input.sessionId },
      ctx.signal,
    );
    return suite;
  },
});
export const showQualification = defineCommand({
  id: "suites.show",
  title: "Collect qualification results",
  cli: true,
  params: { suiteId: params.text({ label: "Suite ID", required: true }) },
  async run(ctx, { suiteId }) {
    return collectQualification(await runDeps(ctx), await readQualification(ctx.storage, suiteId));
  },
});
