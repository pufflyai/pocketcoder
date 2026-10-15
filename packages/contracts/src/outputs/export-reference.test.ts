import { expect, test } from "bun:test";
import { digestOf } from "../common/canonical";
import { WorkloadExportReferenceSchema } from "./export-reference";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const digest = `sha256:${"a".repeat(64)}`;
const execution = { workspaceId: id, incarnationId: "container-1", owner: "process", requestId: id };
const contents = { execution, completeness: "complete", objects: [], errors: [] };
const exported = {
  ...contents,
  exportId: id,
  manifestDigest: digestOf(contents),
  publication: "published",
  publishedAt: "2026-10-15T00:00:00Z",
  expiresAt: "2026-10-15T00:15:00Z",
};

test("export digests freeze execution, immutable objects and completeness independently of availability", () => {
  expect(WorkloadExportReferenceSchema.safeParse(exported).success).toBe(true);
  for (const change of [
    { execution: { ...execution, incarnationId: "another-container" } },
    { completeness: "partial", errors: ["missing result"] },
    {
      objects: [{ objectId: id, objectVersion: digest, name: "result", sizeBytes: 0, mediaType: "text/plain", digest }],
    },
  ]) {
    expect(WorkloadExportReferenceSchema.safeParse({ ...exported, ...change }).success).toBe(false);
  }
  expect(WorkloadExportReferenceSchema.safeParse({ ...exported, publication: "expired" }).success).toBe(true);
  expect(WorkloadExportReferenceSchema.safeParse({ ...exported, expiresAt: exported.publishedAt }).success).toBe(false);
});
