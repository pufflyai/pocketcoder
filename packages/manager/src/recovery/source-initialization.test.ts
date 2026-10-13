import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { initialSourceClaim, requireInitialPreparation } from "./source-initialization";

test("an initial claim pending before publication survives device renumbering", () => {
  const journalId = randomUUID();
  const binding = {
    provider: "digitalocean" as const,
    hostId: 42,
    region: "ams3",
    volumeId: randomUUID(),
    volumeName: "manager",
  };
  const writer = {
    format: "pocketcoder-source-writer/v1" as const,
    directory: "/manager",
    root: { device: "2048", inode: "13" },
    lock: { device: "2048", inode: "14" },
  };
  const intended = initialSourceClaim(journalId, binding, writer, "2048", null);
  const remapped = { ...writer, root: { ...writer.root, device: "2064" }, lock: { ...writer.lock, device: "2064" } };
  expect(initialSourceClaim(journalId, binding, remapped, "2064", intended)).toEqual(intended);
  expect(() => initialSourceClaim(journalId, { ...binding, hostId: 43 }, remapped, "2064", intended)).toThrow();
});

test("initial physical claims cannot reuse transfer or predecessor evidence", () => {
  const journalId = randomUUID();
  const claim = {
    journalId,
    generation: 0,
    sourceTransfer: journalId,
    writer: {
      format: "pocketcoder-source-writer/v1" as const,
      directory: "/manager",
      root: { device: "2048", inode: "13" },
      lock: { device: "2048", inode: "14" },
    },
    sourceBinding: {
      provider: "digitalocean" as const,
      hostId: 42,
      region: "ams3",
      volumeId: randomUUID(),
      volumeName: "manager",
    },
  };
  expect(() => requireInitialPreparation(claim, { initialClaim: claim })).not.toThrow();
  expect(() => requireInitialPreparation(claim, undefined)).toThrow();
  expect(() => requireInitialPreparation(claim, { initialClaim: { ...claim, generation: 1 } })).toThrow();
  expect(() =>
    requireInitialPreparation({ ...claim, sourceTransfer: randomUUID() }, { initialClaim: claim }),
  ).toThrow();
  expect(() => requireInitialPreparation({ ...claim, sourceBinding: undefined }, { initialClaim: claim })).toThrow();
});
