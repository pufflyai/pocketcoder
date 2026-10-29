import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digitalOceanManagerFence } from "./source-host";
import {
  predecessorProgress,
  requireSourceCompletion,
  requireSourcePreparation,
  sourceReadinessDigest,
} from "./source-transfer";
import { ClaimSchema, recoveryReceiptDigest } from "./writer";

const sourceBinding = {
  provider: "digitalocean" as const,
  hostId: 42,
  region: "ams3",
  volumeId: randomUUID(),
  volumeName: "manager",
};
const sourceTransfer = randomUUID();
const claim = ClaimSchema.parse({
  journalId: randomUUID(),
  generation: 1,
  sourceBinding,
  sourceTransfer,
  writer: {
    format: "pocketcoder-source-writer/v1",
    directory: "/manager",
    root: { device: "2048", inode: "13" },
    lock: { device: "2048", inode: "14" },
  },
});
const completion = { operationId: sourceTransfer, claimDigest: recoveryReceiptDigest(claim) };
const progress = { ...completion, state: "complete" as const };

test("a pending successor retains the completed predecessor across crashes before claim publication", () => {
  const pending = { operationId: randomUUID(), claimDigest: "next", state: "pending", predecessor: completion };
  expect(predecessorProgress(pending)).toEqual(progress);
  expect(() =>
    requireSourceCompletion(claim, sourceBinding, predecessorProgress(pending), claim, completion),
  ).not.toThrow();
  expect(() => requireSourceCompletion(claim, sourceBinding, pending, claim, completion)).toThrow();
  expect(() => predecessorProgress({ ...pending, predecessor: undefined })).toThrow();
});

test("every committed transfer retains exact predecessor and saved readiness lineage", () => {
  const { sourceBinding: _, sourceTransfer: __, ...original } = claim;
  const previous = { ...original, generation: 0 };
  const sourceReady = {
    hostId: "12",
    readyAt: "2026-10-13T10:00:00Z",
    bootId: randomUUID(),
    commit: "a".repeat(40),
    sha256: "b".repeat(64),
  };
  const migration = {
    operationId: sourceTransfer,
    previousClaimDigest: recoveryReceiptDigest(previous),
    sourceHost: { hostId: 12, region: "ams3" },
    powerOffActionId: 99,
    sourceReady,
    sourceReadyDigest: sourceReadinessDigest(sourceReady),
  };
  const preparation = { previous, claim, migration };
  expect(requireSourcePreparation(claim, preparation)).toEqual(preparation);
  for (const bad of [
    undefined,
    { ...preparation, previous: { ...previous, generation: 1 } },
    { ...preparation, migration: { ...migration, sourceReadyDigest: "a".repeat(64) } },
    { ...preparation, migration: { ...migration, sourceReady: { ...sourceReady, hostId: "13" } } },
  ]) {
    expect(() => requireSourcePreparation(claim, bad)).toThrow();
  }
  const boundPrevious = { ...previous, sourceBinding: { ...sourceBinding, hostId: 12 }, sourceTransfer: randomUUID() };
  const boundPreparation = {
    ...preparation,
    previous: boundPrevious,
    migration: { ...migration, previousClaimDigest: recoveryReceiptDigest(boundPrevious) },
  };
  expect(requireSourcePreparation(claim, boundPreparation)).toEqual(boundPreparation);
  expect(() =>
    requireSourcePreparation(claim, {
      ...boundPreparation,
      previous: { ...boundPrevious, sourceBinding: { ...sourceBinding, hostId: 12, volumeId: randomUUID() } },
    }),
  ).toThrow();
});

test("admission requires the exact committed host, marker, independent progress and remote completion", () => {
  expect(() => requireSourceCompletion(claim, sourceBinding, progress, claim, completion)).not.toThrow();
  for (const state of [
    undefined,
    { ...progress, state: "pending" },
    { ...progress, operationId: randomUUID() },
    { ...progress, claimDigest: "wrong" },
  ]) {
    expect(() => requireSourceCompletion(claim, sourceBinding, state, claim, completion)).toThrow();
  }
  expect(() => requireSourceCompletion(claim, { ...sourceBinding, hostId: 43 }, progress, claim, completion)).toThrow();
  expect(() =>
    requireSourceCompletion(claim, sourceBinding, progress, { ...claim, generation: 0 }, completion),
  ).toThrow();
  expect(() =>
    requireSourceCompletion(claim, sourceBinding, progress, claim, { ...completion, operationId: randomUUID() }),
  ).toThrow();
});
test("the source fence must be completed, exact and later than saved pre-fault readiness", () => {
  const host = { provider: "digitalocean" as const, dropletId: 12, region: "ams3" };
  const action = {
    id: 99,
    resource_id: 12,
    resource_type: "droplet",
    type: "power_off",
    status: "completed",
    completed_at: "2026-10-13T10:01:00Z",
  };
  const droplet = { id: 12, region: { slug: "ams3" }, status: "off", locked: false };
  expect(() => digitalOceanManagerFence(host, 99, "2026-10-13T10:00:00Z", { action }, { droplet })).not.toThrow();
  for (const bad of [
    { ...action, resource_id: 13 },
    { ...action, type: "shutdown" },
    { ...action, status: "in-progress" },
    { ...action, completed_at: "2026-10-13T10:00:00Z" },
  ]) {
    expect(() => digitalOceanManagerFence(host, 99, "2026-10-13T10:00:00Z", { action: bad }, { droplet })).toThrow();
  }
  expect(() =>
    digitalOceanManagerFence(
      host,
      99,
      "2026-10-13T10:00:00Z",
      { action },
      { droplet: { ...droplet, status: "active" } },
    ),
  ).toThrow();
});
