import { existsSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ObjectStorageError, readPrivateFile, writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import type { ManagerContext } from "../database/context";
import type { PurgeAuthority } from "../purge/authority";
import { canonicalSourceWriter, type SourceBinding, verifySource } from "./source-binding";
import { digitalOceanManagerFence } from "./source-host";
import { initializeManagerSource, requireInitialPreparation } from "./source-initialization";
import {
  ClaimSchema,
  InstallationSchema,
  installationPath,
  publishManagerWriter,
  recoveryReceiptDigest,
} from "./writer";

export const SourceMigrationSchema = z.strictObject({
  operationId: z.uuid(),
  previousClaimDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHost: z.strictObject({ hostId: z.number().int().positive(), region: z.string().min(1) }),
  powerOffActionId: z.number().int().positive(),
  sourceReady: z.strictObject({
    hostId: z.string().regex(/^[1-9]\d*$/),
    readyAt: z.iso.datetime(),
    bootId: z.uuid(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  sourceReadyDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const SourceProgressSchema = z.strictObject({
  operationId: z.uuid(),
  claimDigest: z.string(),
  state: z.enum(["pending", "complete"]),
  predecessor: z.strictObject({ operationId: z.uuid(), claimDigest: z.string() }).optional(),
});
const readJson = async (path: string) => JSON.parse((await readPrivateFile(path, 65536)).toString()) as unknown;
export async function immutableSourceRecord(authority: PurgeAuthority, key: string, value: unknown) {
  authority.dependencies.validate();
  try {
    await authority.storage.putIfAbsent(key, Buffer.from(JSON.stringify(value)));
  } catch (error) {
    if (!(error instanceof ObjectStorageError) || error.status !== 412) throw error;
  }
  if (!isDeepStrictEqual(await (await authority.storage.get(key)).json(), value))
    throw new Error("Manager source transfer has another immutable winner.");
  authority.dependencies.validate();
}

export async function recheckSourceTarget(
  context: ManagerContext,
  config: NonNullable<PurgeAuthority["sourceConfig"]>,
  verified: Awaited<ReturnType<typeof verifySource>>,
  previous: z.infer<typeof ClaimSchema>,
) {
  const rechecked = await verifySource(config);
  if (!isDeepStrictEqual(rechecked.binding, verified.binding) || rechecked.blockDevice !== verified.blockDevice)
    throw new Error("Manager target source changed during transfer.");
  const observed = context.sourceWriter();
  if (!observed) throw new Error("Manager source lock is missing.");
  canonicalSourceWriter(previous.writer, observed, rechecked.blockDevice);
}

async function migrateSource(
  context: ManagerContext,
  authority: PurgeAuthority,
  current: z.infer<typeof ClaimSchema>,
  verified: Awaited<ReturnType<typeof verifySource>>,
  config: NonNullable<PurgeAuthority["sourceConfig"]>,
  progress: z.infer<typeof SourceProgressSchema> | undefined,
  local: z.infer<typeof InstallationSchema>,
  markerPath: string,
  progressPath: string,
) {
  if (!config.migrationFile) throw new Error("Manager source migration proof is required.");
  const migration = SourceMigrationSchema.parse(await readJson(config.migrationFile));
  if (
    migration.sourceHost.hostId === verified.binding.hostId ||
    migration.sourceHost.region !== verified.binding.region ||
    migration.sourceReady.hostId !== String(migration.sourceHost.hostId) ||
    sourceReadinessDigest(migration.sourceReady) !== migration.sourceReadyDigest
  )
    throw new Error("Manager transfer host evidence differs.");
  const resuming = progress?.state === "pending" && current.sourceTransfer === migration.operationId;
  const previous = resuming
    ? ClaimSchema.parse(
        (
          (await (
            await authority.storage.get(`manager/source-transfers/${migration.operationId}/prepare.json`)
          ).json()) as { previous: unknown }
        ).previous,
      )
    : current;
  if (
    recoveryReceiptDigest(previous) !== migration.previousClaimDigest ||
    (previous.sourceBinding &&
      (previous.sourceBinding.hostId !== migration.sourceHost.hostId ||
        previous.sourceBinding.volumeId !== verified.binding.volumeId ||
        previous.sourceBinding.volumeName !== verified.binding.volumeName ||
        previous.sourceBinding.region !== verified.binding.region))
  )
    throw new Error("Manager original claim digest differs.");
  if (!resuming && previous.sourceBinding) {
    if (!previous.sourceTransfer) throw new Error("Manager predecessor transfer identity is missing.");
    const priorCompletion = await (
      await authority.storage.get(`manager/source-transfers/${previous.sourceTransfer}/complete.json`)
    ).json();
    requireSourceCompletion(previous, previous.sourceBinding, predecessorProgress(progress), local, priorCompletion);
    await verifyPreparation(authority, previous);
  }
  const claim = {
    ...previous,
    generation: previous.generation + 1,
    sourceBinding: verified.binding,
    sourceTransfer: migration.operationId,
  };
  const claimDigest = recoveryReceiptDigest(claim);
  if (
    progress?.state === "pending" &&
    (progress.operationId !== migration.operationId ||
      progress.claimDigest !== claimDigest ||
      progress.state !== "pending")
  )
    throw new Error("Manager source transfer progress differs.");
  if (!isDeepStrictEqual(local, previous) && !isDeepStrictEqual(local, claim))
    throw new Error("Manager local source marker differs.");
  async function requireFence() {
    const source = migration.sourceHost;
    const [action, host] = await Promise.all([
      verified.api.request(
        verified.api.endpoint(`/v2/droplets/${source.hostId}/actions/${migration.powerOffActionId}`),
        "GET",
      ),
      verified.api.request(verified.api.endpoint(`/v2/droplets/${source.hostId}`), "GET"),
    ]);
    digitalOceanManagerFence(
      { provider: "digitalocean", dropletId: source.hostId, region: source.region },
      migration.powerOffActionId,
      migration.sourceReady.readyAt,
      action,
      host,
    );
  }
  await requireFence();
  const predecessor =
    progress?.state === "complete"
      ? { operationId: progress.operationId, claimDigest: progress.claimDigest }
      : progress?.predecessor;
  progress = {
    operationId: migration.operationId,
    claimDigest,
    state: "pending",
    ...(predecessor ? { predecessor } : {}),
  };
  await persistSourceProgress(authority, progressPath, progress);
  await immutableSourceRecord(authority, `manager/source-transfers/${migration.operationId}/prepare.json`, {
    previous,
    claim,
    migration,
  });
  await publishManagerWriter(authority, claim);
  // A claim alone never opens admission. Complete the post-publication fence check first.
  await requireFence();
  await recheckSourceTarget(context, config, verified, previous);
  await immutableSourceRecord(authority, `manager/source-transfers/${migration.operationId}/complete.json`, {
    operationId: migration.operationId,
    claimDigest,
  });
  context.validate();
  await writePrivateJson(markerPath, claim, 65536);
  context.validate();
  progress = { operationId: progress.operationId, claimDigest: progress.claimDigest, state: "complete" };
  await persistSourceProgress(authority, progressPath, progress);
  return { claim, progress };
}

export async function authorizeManagerSource(
  context: ManagerContext,
  authority: PurgeAuthority,
  current: z.infer<typeof ClaimSchema> | null,
) {
  const config = authority.sourceConfig;
  if (!config || !context.directory)
    throw new Error("Manager physical source configuration and original claim are required.");
  const verified = await verifySource(config);
  if (
    !current ||
    (current.generation === 0 &&
      current.sourceTransfer === current.journalId &&
      isDeepStrictEqual(current.sourceBinding, verified.binding))
  )
    current = await initializeManagerSource(context, authority, current, verified);
  const observed = context.sourceWriter();
  if (!observed) throw new Error("Manager source lock is missing.");
  canonicalSourceWriter(current.writer, observed, verified.blockDevice);
  const progressPath = join(authority.dependencies.directory, "source-transfer.json");
  const markerPath = installationPath(context.directory);
  const local = InstallationSchema.parse(await readJson(markerPath));
  let progress = existsSync(progressPath) ? SourceProgressSchema.parse(await readJson(progressPath)) : undefined;
  let claim = current;
  if (
    !isDeepStrictEqual(current.sourceBinding, verified.binding) ||
    (progress?.state === "pending" && current.sourceTransfer === progress.operationId)
  ) {
    ({ claim, progress } = await migrateSource(
      context,
      authority,
      current,
      verified,
      config,
      progress,
      local,
      markerPath,
      progressPath,
    ));
  }
  if (!claim.sourceTransfer) throw new Error("Manager physical transfer identity is missing.");
  const completion = await (
    await authority.storage.get(`manager/source-transfers/${claim.sourceTransfer}/complete.json`)
  ).json();
  requireSourceCompletion(claim, verified.binding, progress, await readJson(markerPath), completion);
  await verifyPreparation(authority, claim);
  const raw = context.sourceWriter;
  context.sourceWriter = () => {
    const writer = raw();
    const device = statSync(config.blockDevice, { bigint: true });
    if (!device.isBlockDevice() || !writer) throw new Error("Manager physical source is unavailable.");
    return canonicalSourceWriter(claim.writer, writer, device.rdev.toString());
  };
  context.validate();
  authority.dependencies.validate();
  return claim;
}

export function requireExistingSource(directory: string) {
  if (!lstatSync(directory).isDirectory() || !lstatSync(join(directory, "LOCK")).isFile())
    throw new Error("Original manager source is missing.");
}

export function requireSourceCompletion(
  claim: z.infer<typeof ClaimSchema>,
  binding: SourceBinding,
  progressValue: unknown,
  marker: unknown,
  completion: unknown,
) {
  const progress = SourceProgressSchema.parse(progressValue);
  if (
    !isDeepStrictEqual(claim.sourceBinding, binding) ||
    !claim.sourceTransfer ||
    progress.state !== "complete" ||
    progress.operationId !== claim.sourceTransfer ||
    progress.claimDigest !== recoveryReceiptDigest(claim)
  )
    throw new Error("Manager physical source transfer is incomplete or belongs to another host.");
  if (!isDeepStrictEqual(completion, { operationId: claim.sourceTransfer, claimDigest: progress.claimDigest }))
    throw new Error("Manager source completion evidence differs.");
  if (!isDeepStrictEqual(InstallationSchema.parse(marker), claim))
    throw new Error("Manager source marker was rolled back.");
}

export function requireSourcePreparation(claim: z.infer<typeof ClaimSchema>, value: unknown) {
  const preparation = z
    .strictObject({ previous: ClaimSchema, claim: ClaimSchema, migration: SourceMigrationSchema })
    .parse(value);
  const { previous, migration } = preparation;
  if (
    !isDeepStrictEqual(preparation.claim, claim) ||
    migration.operationId !== claim.sourceTransfer ||
    migration.previousClaimDigest !== recoveryReceiptDigest(previous) ||
    claim.generation !== previous.generation + 1 ||
    claim.journalId !== previous.journalId ||
    !isDeepStrictEqual(previous.writer, claim.writer) ||
    migration.sourceReady.hostId !== String(migration.sourceHost.hostId) ||
    sourceReadinessDigest(migration.sourceReady) !== migration.sourceReadyDigest ||
    migration.sourceHost.hostId === claim.sourceBinding?.hostId ||
    migration.sourceHost.region !== claim.sourceBinding?.region
  )
    throw new Error("Manager source preparation lineage differs.");
  if (
    previous.sourceBinding &&
    (!isDeepStrictEqual({ ...previous.sourceBinding, hostId: claim.sourceBinding?.hostId }, claim.sourceBinding) ||
      previous.sourceBinding.hostId !== migration.sourceHost.hostId)
  )
    throw new Error("Manager source predecessor binding differs.");
  return preparation;
}

export async function verifyPreparation(authority: PurgeAuthority, current: z.infer<typeof ClaimSchema>) {
  let claim = current;
  while (claim.sourceBinding) {
    if (!claim.sourceTransfer) throw new Error("Manager transfer identity is missing.");
    const completion = await (
      await authority.storage.get(`manager/source-transfers/${claim.sourceTransfer}/complete.json`)
    ).json();
    if (
      !isDeepStrictEqual(completion, { operationId: claim.sourceTransfer, claimDigest: recoveryReceiptDigest(claim) })
    )
      throw new Error("Manager predecessor completion differs.");
    if (claim.generation === 0) {
      const initial = await (
        await authority.storage.get(`manager/source-transfers/${claim.sourceTransfer}/prepare.json`)
      ).json();
      requireInitialPreparation(claim, initial);
      break;
    }
    const preparation = requireSourcePreparation(
      claim,
      await (await authority.storage.get(`manager/source-transfers/${claim.sourceTransfer}/prepare.json`)).json(),
    );
    const previous = preparation.previous;
    const retained = ClaimSchema.parse(
      await (await authority.storage.get(`manager/writers/${previous.journalId}/${previous.generation}.json`)).json(),
    );
    if (!isDeepStrictEqual(retained, previous)) throw new Error("Manager transfer predecessor was changed.");
    claim = previous;
  }
}

export function predecessorProgress(value: unknown) {
  const progress = SourceProgressSchema.parse(value);
  if (progress.state === "complete") return progress;
  if (!progress.predecessor) throw new Error("Manager pending transfer lost predecessor progress.");
  return { ...progress.predecessor, state: "complete" as const };
}

export async function persistSourceProgress(
  authority: PurgeAuthority,
  path: string,
  progress: z.infer<typeof SourceProgressSchema>,
) {
  authority.dependencies.validate();
  await writePrivateJson(path, progress, 65536);
  authority.dependencies.validate();
}

export const sourceReadinessDigest = (ready: z.infer<typeof SourceMigrationSchema>["sourceReady"]) =>
  recoveryReceiptDigest(Object.fromEntries(Object.entries(ready).sort(([left], [right]) => left.localeCompare(right))));
