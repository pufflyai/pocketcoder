import { z } from "zod";

export const RESULT_MARKER = "REMOTE_TEST_RESULT ";
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const object = z.object({ url: z.url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
export const GitSourceSchema = z
  .object({
    kind: z.enum(["commit", "dirty"]),
    base: z.object({ ref: z.literal("origin/main"), sha, bundle: object }),
    head: z.object({ sha, tree: sha, bundle: object.nullable() }),
    overlay: z.object({ ...object.shape, deleted: z.array(z.string()) }).nullable(),
  })
  .refine((s) => (s.kind === "dirty") === (s.overlay !== null), "dirty source requires an overlay");
export type GitSource = z.infer<typeof GitSourceSchema>;
export const RunRequestSchema = z.object({
  type: z.literal("pocketcoder.remote-test/v2"),
  runId: z.uuid(),
  releaseAfterRun: z.boolean().default(false),
  source: GitSourceSchema,
  requires: z.array(z.enum(["git-history", "docker", "browsers"])),
  target: z.object({ os: z.string(), arch: z.string() }).optional(),
  command: z.string().min(1).max(4096),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(6 * 3600),
  deadlineAt: z.iso.datetime(),
  runtime: z.object({ template: z.string(), image: z.string(), placement: z.string() }),
  log: z.object({ url: z.url() }),
  results: z.object({ url: z.url(), paths: z.array(z.string()).min(1).max(16), maxBytes: z.number().int().positive() }),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RunStatus =
  | "passed"
  | "failed"
  | "timed_out"
  | "canceled"
  | "error"
  | "prerequisite_missing"
  | "source_unavailable";
export interface RunResult {
  runId: string | null;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  durationMs: number;
  source?: { kind: GitSource["kind"]; head: string; base: string; tree: string; mergeBase: string };
  target: { os: string; arch: string };
  runtime?: RunRequest["runtime"] & { bun: string; node: string; playwright: string; docker: string };
  preflight: { check: string; ok: boolean; detail?: string }[];
  log: { uploaded: boolean; bytes: number };
  results: { uploaded: boolean; bytes: number };
  reason?: "environment_busy";
  error?: string;
}

export function parseRequest(message: string) {
  return RunRequestSchema.parse(JSON.parse(message.split("\n\n")[0] ?? ""));
}

export const RunResultSchema: z.ZodType<RunResult> = z.object({
  runId: z.string().nullable(),
  status: z.enum(["passed", "failed", "timed_out", "canceled", "error", "prerequisite_missing", "source_unavailable"]),
  exitCode: z.number().int().nullable(),
  startedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  source: z.object({ kind: z.enum(["commit", "dirty"]), head: sha, base: sha, tree: sha, mergeBase: sha }).optional(),
  target: z.object({ os: z.string(), arch: z.string() }),
  runtime: z
    .object({
      template: z.string(),
      image: z.string(),
      placement: z.string(),
      bun: z.string(),
      node: z.string(),
      playwright: z.string(),
      docker: z.string(),
    })
    .optional(),
  preflight: z.array(z.object({ check: z.string(), ok: z.boolean(), detail: z.string().optional() })),
  log: z.object({ uploaded: z.boolean(), bytes: z.number().nonnegative() }),
  results: z.object({ uploaded: z.boolean(), bytes: z.number().nonnegative() }),
  reason: z.literal("environment_busy").optional(),
  error: z.string().max(8192).optional(),
});
