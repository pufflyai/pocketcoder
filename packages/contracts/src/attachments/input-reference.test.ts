import { expect, test } from "bun:test";
import { digestOf } from "../common/canonical";
import { AcceptedInputManifestSchema, InputObjectReferenceSchema } from "./input-reference";

const fixtureDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const object = {
  workspaceId,
  fileId: workspaceId,
  objectVersion: fixtureDigest,
  name: "input",
  mediaType: "text/plain",
  sizeBytes: 0,
  digest: fixtureDigest,
  visibility: "ready",
};
const contents = { workspaceId, incarnationId: "container-1", objects: [object] };
const inputs = { ...contents, digest: digestOf(contents) };

test("accepted inputs bind exact ready workspace-scoped versions and their manifest digest", () => {
  expect(AcceptedInputManifestSchema.safeParse(inputs).success).toBe(true);
  for (const objects of [
    [{ ...object, workspaceId: otherId }],
    [{ ...object, visibility: "expired" }],
    [object, object],
  ]) {
    expect(AcceptedInputManifestSchema.safeParse({ ...inputs, objects }).success).toBe(false);
  }
  expect(AcceptedInputManifestSchema.safeParse({ ...inputs, digest: `sha256:${"b".repeat(64)}` }).success).toBe(false);
  expect(InputObjectReferenceSchema.safeParse({ ...object, path: "/host/private" }).success).toBe(false);
});
