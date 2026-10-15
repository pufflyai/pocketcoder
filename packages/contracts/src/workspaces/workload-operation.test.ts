import { expect, test } from "bun:test";
import { digestOf } from "../common/canonical";
import { WorkloadAcceptanceSchema } from "./workload-operation";

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
const execution = { workspaceId, incarnationId: "container-1", owner: "process", requestId: workspaceId };

test("acceptance fingerprints freeze input, caller, adapter, operation and binding identities", () => {
  const facts = {
    execution,
    callerPrincipalId: workspaceId,
    templateDigest: fixtureDigest,
    adapterDigest: fixtureDigest,
    operation: "run",
    input: {},
    inputs,
    bindingSetDigest: digestOf([]),
  };
  const accepted = { ...facts, fingerprint: digestOf(facts) };
  expect(WorkloadAcceptanceSchema.safeParse(accepted).success).toBe(true);
  for (const change of [
    { input: { changed: true } },
    { callerPrincipalId: otherId },
    { bindingSetDigest: fixtureDigest },
    { execution: { ...execution, incarnationId: "restored-container" } },
  ]) {
    expect(WorkloadAcceptanceSchema.safeParse({ ...accepted, ...change }).success).toBe(false);
  }
});
