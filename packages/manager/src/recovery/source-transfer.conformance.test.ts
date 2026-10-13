import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { managerContext } from "../database/context";
import { ManagerStore } from "../database/store";
import { createPurgeAuthority } from "../purge/authority";
import { sourceReadinessDigest, verifyPreparation } from "./source-transfer";
import { bindManagerWriter, publishManagerWriter, recoveryReceiptDigest, transferManagerWriter } from "./writer";

test.skipIf(process.env.PC102_S3_TEST !== "1")(
  "a later bound writer requires its original initialization completion in real storage",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pc103-initial-binding-"));
    const fixture = await objectStorageFixture();
    const data = join(directory, "manager");
    const context = await managerContext(data);
    const authority = await createPurgeAuthority(data, {
      directory: join(directory, "journal"),
      storage: fixture.config,
    });
    try {
      const journalId = authority.journal.head().journalId;
      const writer = context.sourceWriter();
      if (!writer) throw new Error("Expected the actual held writer.");
      const previous = {
        journalId,
        generation: 0,
        writer,
        sourceBinding: {
          provider: "digitalocean" as const,
          hostId: 12,
          region: "ams3",
          volumeId: randomUUID(),
          volumeName: "manager",
        },
        sourceTransfer: journalId,
      };
      const initialCompletion = `manager/source-transfers/${journalId}/complete.json`;
      await authority.storage.putIfAbsent(
        `manager/source-transfers/${journalId}/prepare.json`,
        Buffer.from(JSON.stringify({ initialClaim: previous })),
      );
      await publishManagerWriter(authority, previous);
      await authority.storage.putIfAbsent(
        initialCompletion,
        Buffer.from(JSON.stringify({ operationId: journalId, claimDigest: recoveryReceiptDigest(previous) })),
      );
      const operationId = randomUUID();
      const claim = {
        ...previous,
        generation: 1,
        sourceBinding: { ...previous.sourceBinding, hostId: 42 },
        sourceTransfer: operationId,
      };
      const sourceReady = {
        hostId: "12",
        readyAt: "2026-10-13T10:00:00Z",
        bootId: randomUUID(),
        commit: "a".repeat(40),
        sha256: "b".repeat(64),
      };
      const migration = {
        operationId,
        previousClaimDigest: recoveryReceiptDigest(previous),
        sourceHost: { hostId: 12, region: "ams3" },
        powerOffActionId: 99,
        sourceReady,
        sourceReadyDigest: sourceReadinessDigest(sourceReady),
      };
      await authority.storage.putIfAbsent(
        `manager/source-transfers/${operationId}/prepare.json`,
        Buffer.from(JSON.stringify({ previous, claim, migration })),
      );
      await publishManagerWriter(authority, claim);
      await authority.storage.putIfAbsent(
        `manager/source-transfers/${operationId}/complete.json`,
        Buffer.from(JSON.stringify({ operationId, claimDigest: recoveryReceiptDigest(claim) })),
      );
      await verifyPreparation(authority, claim);
      await authority.storage.clean(initialCompletion);
      await expect(verifyPreparation(authority, claim)).rejects.toThrow();
    } finally {
      await context.close();
      authority.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(process.env.PC102_S3_TEST !== "1")(
  "real immutable storage preserves a bound writer and rejects missing lineage and unverified entry points",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pc103-source-binding-"));
    const fixture = await objectStorageFixture();
    const data = join(directory, "manager");
    const config = { directory: join(directory, "journal"), storage: fixture.config };
    const context = await managerContext(data);
    const authority = await createPurgeAuthority(data, config);
    try {
      const previous = await bindManagerWriter(context, authority);
      const operationId = randomUUID();
      const sourceReady = {
        hostId: "12",
        readyAt: "2026-10-13T10:00:00Z",
        bootId: randomUUID(),
        commit: "a".repeat(40),
        sha256: "b".repeat(64),
      };
      const claim = {
        ...previous,
        generation: 1,
        sourceBinding: {
          provider: "digitalocean" as const,
          hostId: 42,
          region: "ams3",
          volumeId: randomUUID(),
          volumeName: "manager",
        },
        sourceTransfer: operationId,
      };
      const migration = {
        operationId,
        previousClaimDigest: recoveryReceiptDigest(previous),
        sourceHost: { hostId: 12, region: "ams3" },
        powerOffActionId: 99,
        sourceReady,
        sourceReadyDigest: sourceReadinessDigest(sourceReady),
      };
      const prepare = `manager/source-transfers/${operationId}/prepare.json`;
      await authority.storage.putIfAbsent(prepare, Buffer.from(JSON.stringify({ previous, claim, migration })));
      await publishManagerWriter(authority, claim);
      await authority.storage.putIfAbsent(
        `manager/source-transfers/${operationId}/complete.json`,
        Buffer.from(JSON.stringify({ operationId, claimDigest: recoveryReceiptDigest(claim) })),
      );
      await verifyPreparation(authority, claim);
      await expect(transferManagerWriter(context, authority, randomUUID(), {})).rejects.toThrow(
        "verified physical source",
      );
      await authority.storage.clean(prepare);
      await expect(verifyPreparation(authority, claim)).rejects.toThrow();
      await context.close();
      authority.close();
      await expect(ManagerStore.create(data, config)).rejects.toThrow("physical source configuration");
    } finally {
      await context.close();
      authority.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
