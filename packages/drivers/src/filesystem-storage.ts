import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import {
	chmod,
	chown,
	copyFile,
	lchown,
	lstat,
	lutimes,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
	type CheckpointManifest,
	CheckpointManifestSchema,
	canonicalJson,
	digestOf,
	type PersistenceMount,
} from "@pstdio/pocketcoder-contracts";
import type {
	AllocatedStorage,
	CheckpointRef,
	DiscoveredCheckpoint,
	DiscoveredStorage,
	RuntimeMountRef,
	SnapshotResult,
	StorageAllocation,
	StorageRef,
	WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";

interface FilesystemRef extends StorageRef {
	kind: "filesystem";
	root: string;
	uid?: number;
	gid?: number;
}

interface ScanCounters {
	bytes: number;
	files: number;
}

type ManifestEntry = CheckpointManifest["mounts"][number]["entries"][number];
type WalkDirectory = (directory: string, relativeDirectory: string) => Promise<void>;

interface ScanContext {
	entries: ManifestEntry[];
	counters: ScanCounters;
	mount: PersistenceMount;
	destinationRoot?: string;
}

interface StorageMetadata {
	format: "pocketcoder-storage/v1";
	storage_id: string;
	workspace_id: string;
}

interface CheckpointMetadata {
	format: "pocketcoder-checkpoint-metadata/v1";
	checkpoint_id: string;
	manifest_digest: string;
}

const STORAGE_METADATA_FILE = ".pocketcoder-storage.json";
const CHECKPOINT_METADATA_FILE = ".pocketcoder-checkpoint.json";
const MANIFEST_FILE = "manifest.json";

export interface FilesystemStorageDriverOptions {
	workspaceRoot: string;
	checkpointRoot: string;
}

function assertSafeRoot(value: string, name: string): string {
	if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
	const normalized = resolve(value);
	if (normalized === resolve(sep)) throw new Error(`${name} must not be the filesystem root`);
	if (normalized === resolve(process.cwd())) {
		throw new Error(`${name} must not be the PocketCoder process working directory`);
	}
	return normalized;
}

function filesystemRef(value: StorageRef | CheckpointRef): FilesystemRef {
	if (value.kind !== "filesystem" || typeof value.root !== "string" || !isAbsolute(value.root)) {
		throw new Error("invalid filesystem storage reference");
	}
	return value as FilesystemRef;
}

function childOf(root: string, id: string): string {
	if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("storage IDs must be UUIDs");
	const child = resolve(root, id);
	if (relative(root, child).startsWith("..")) throw new Error("storage path escaped its root");
	return child;
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return `sha256:${hash.digest("hex")}`;
}

async function safeOwnership(
	path: string,
	uid: number,
	gid: number,
	directory: boolean,
): Promise<void> {
	try {
		await chown(path, uid, gid);
		await chmod(path, directory ? 0o770 : 0o660);
	} catch {
		// Rootless local development cannot chown to the template UID. The
		// opaque parent remains 0700; only the explicitly mounted child is
		// made writable so Docker Desktop/rootless containers can use it.
		await chmod(path, directory ? 0o777 : 0o666);
	}
}

function safeRelativePath(value: string): boolean {
	if (!value || value.includes("\0") || value.includes("\\")) return false;
	if (value !== value.normalize("NFC")) return false;
	return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function safeSymlinkTarget(entryPath: string, target: string): boolean {
	if (!target || target.startsWith("/") || target.includes("\0") || target.includes("\\")) {
		return false;
	}
	const resolved = normalize(join(dirname(entryPath), target));
	return resolved !== ".." && !resolved.startsWith(`..${sep}`) && !isAbsolute(resolved);
}

async function setTimes(path: string, mtimeMs: number): Promise<void> {
	try {
		await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
	} catch {
		// Some rootless/container filesystems do not permit symlink timestamp
		// updates. Content integrity does not depend on the syscall succeeding.
	}
}

async function setLinkTimes(path: string, mtimeMs: number): Promise<void> {
	try {
		await lutimes(path, mtimeMs / 1000, mtimeMs / 1000);
	} catch {
		// Symlink timestamps are best effort on filesystems that do not expose
		// lutimes. The manifest still records them for capable restore targets.
	}
}

function entryMetadata(path: string, stat: Stats) {
	return {
		path,
		mode: stat.mode & 0o777,
		uid: stat.uid,
		gid: stat.gid,
		mtime_ns: String(Math.max(0, Math.trunc(stat.mtimeMs * 1_000_000))),
	};
}

function recordEntry(context: ScanContext): void {
	context.counters.files += 1;
	if (context.counters.files > context.mount.maxFiles) {
		throw new Error(`checkpoint mount ${context.mount.name} exceeds maxFiles`);
	}
}

function recordBytes(context: ScanContext, bytes: number): void {
	context.counters.bytes += bytes;
	if (context.counters.bytes > context.mount.maxBytes) {
		throw new Error(`checkpoint mount ${context.mount.name} exceeds maxBytes`);
	}
}

async function scanDirectory(
	context: ScanContext,
	source: string,
	destination: string | null,
	entryPath: string,
	stat: Stats,
	walk: WalkDirectory,
): Promise<void> {
	const common = entryMetadata(entryPath, stat);
	context.entries.push({ ...common, kind: "directory", size: 0 });
	if (destination) await mkdir(destination, { recursive: true, mode: common.mode });
	await walk(source, entryPath);
	if (!destination) return;
	await chmod(destination, common.mode);
	await setTimes(destination, stat.mtimeMs);
}

async function scanFile(
	context: ScanContext,
	source: string,
	destination: string | null,
	entryPath: string,
	stat: Stats,
): Promise<void> {
	recordBytes(context, stat.size);
	const common = entryMetadata(entryPath, stat);
	context.entries.push({
		...common,
		kind: "file",
		size: stat.size,
		digest: await hashFile(source),
	});
	if (!destination) return;
	await mkdir(resolve(destination, ".."), { recursive: true });
	await copyFile(source, destination);
	await chmod(destination, common.mode);
	await setTimes(destination, stat.mtimeMs);
}

async function scanSymlink(
	context: ScanContext,
	source: string,
	destination: string | null,
	entryPath: string,
	stat: Stats,
): Promise<void> {
	const target = await readlink(source);
	if (!safeSymlinkTarget(entryPath, target)) {
		throw new Error("checkpoint contains an absolute or traversing symlink");
	}
	const size = Buffer.byteLength(target);
	recordBytes(context, size);
	context.entries.push({
		...entryMetadata(entryPath, stat),
		kind: "symlink",
		size,
		digest: `sha256:${createHash("sha256").update(target).digest("hex")}`,
		link_target: target,
	});
	if (!destination) return;
	await mkdir(resolve(destination, ".."), { recursive: true });
	await symlink(target, destination);
	await setLinkTimes(destination, stat.mtimeMs);
}

async function scanEntry(
	context: ScanContext,
	directory: string,
	relativeDirectory: string,
	name: string,
	walk: WalkDirectory,
): Promise<void> {
	const entryPath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
	if (!safeRelativePath(entryPath)) throw new Error("checkpoint contains an unsafe path");
	const source = join(directory, name);
	const stat = await lstat(source);
	if ((stat.mode & 0o6000) !== 0) {
		throw new Error("checkpoint contains setuid or setgid mode bits");
	}
	recordEntry(context);
	const destination = context.destinationRoot ? join(context.destinationRoot, entryPath) : null;
	if (stat.isDirectory()) {
		await scanDirectory(context, source, destination, entryPath, stat, walk);
		return;
	}
	if (stat.isFile()) {
		await scanFile(context, source, destination, entryPath, stat);
		return;
	}
	if (stat.isSymbolicLink()) {
		await scanSymlink(context, source, destination, entryPath, stat);
		return;
	}
	throw new Error("checkpoint contains a socket, device, FIFO, or unsupported file type");
}

async function scanMount(
	sourceRoot: string,
	mount: PersistenceMount,
	destinationRoot?: string,
): Promise<{ entries: CheckpointManifest["mounts"][number]["entries"]; counters: ScanCounters }> {
	const entries: CheckpointManifest["mounts"][number]["entries"] = [];
	const counters: ScanCounters = { bytes: 0, files: 0 };
	const context: ScanContext = { entries, counters, mount, destinationRoot };

	const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
		const children = await readdir(directory, { withFileTypes: true });
		children.sort((a, b) => a.name.localeCompare(b.name, "en"));
		for (const child of children) {
			await scanEntry(context, directory, relativeDirectory, child.name, walk);
		}
	};

	await walk(sourceRoot, "");
	return { entries, counters };
}

async function makeReadOnly(path: string): Promise<void> {
	const stat = await lstat(path);
	if (stat.isDirectory()) {
		for (const child of await readdir(path)) await makeReadOnly(join(path, child));
		await chmod(path, 0o500);
	} else if (stat.isFile()) {
		await chmod(path, 0o400);
	}
}

async function makeWritable(path: string): Promise<void> {
	const stat = await lstat(path);
	if (stat.isDirectory()) {
		await chmod(path, 0o700);
		for (const child of await readdir(path)) await makeWritable(join(path, child));
	} else if (stat.isFile()) {
		await chmod(path, 0o600);
	}
}

export class FilesystemStorageDriver implements WorkspaceStorageDriver {
	readonly kind = "filesystem";
	private readonly workspaceRoot: string;
	private readonly checkpointRoot: string;

	constructor(options: FilesystemStorageDriverOptions) {
		this.workspaceRoot = assertSafeRoot(options.workspaceRoot, "workspaceRoot");
		this.checkpointRoot = assertSafeRoot(options.checkpointRoot, "checkpointRoot");
		if (this.workspaceRoot === this.checkpointRoot) {
			throw new Error("workspaceRoot and checkpointRoot must be different");
		}
		if (
			!relative(this.workspaceRoot, this.checkpointRoot).startsWith("..") ||
			!relative(this.checkpointRoot, this.workspaceRoot).startsWith("..")
		) {
			throw new Error("workspaceRoot and checkpointRoot must not overlap");
		}
	}

	private async initRoots(): Promise<void> {
		await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
		await mkdir(this.checkpointRoot, { recursive: true, mode: 0o700 });
		await chmod(this.workspaceRoot, 0o700);
		await chmod(this.checkpointRoot, 0o700);
	}

	private storageRef(ref: StorageRef): FilesystemRef {
		const storage = filesystemRef(ref);
		if (storage.root !== childOf(this.workspaceRoot, storage.id)) {
			throw new Error("storage reference does not match its opaque allocation");
		}
		return storage;
	}

	private checkpointRef(ref: CheckpointRef): FilesystemRef {
		const checkpoint = filesystemRef(ref);
		if (checkpoint.root !== childOf(this.checkpointRoot, checkpoint.id)) {
			throw new Error("checkpoint reference does not match its opaque allocation");
		}
		return checkpoint;
	}

	async allocate(input: StorageAllocation): Promise<AllocatedStorage> {
		await this.initRoots();
		const root = childOf(this.workspaceRoot, input.storageId);
		await mkdir(root, { recursive: true, mode: 0o700 });
		await chmod(root, 0o700);
		for (const mount of input.mounts) {
			const path = join(root, mount.name);
			await mkdir(path, { recursive: true, mode: 0o770 });
			await safeOwnership(path, input.uid, input.gid, true);
		}
		const metadata: StorageMetadata = {
			format: "pocketcoder-storage/v1",
			storage_id: input.storageId,
			workspace_id: input.workspaceId,
		};
		await writeFile(join(root, STORAGE_METADATA_FILE), canonicalJson(metadata), { mode: 0o600 });
		const ref: FilesystemRef = {
			kind: "filesystem",
			id: input.storageId,
			root,
			uid: input.uid,
			gid: input.gid,
		};
		return { ref, mounts: await this.runtimeMounts(ref, input.mounts) };
	}

	async runtimeMounts(ref: StorageRef, mounts: PersistenceMount[]): Promise<RuntimeMountRef[]> {
		const storage = this.storageRef(ref);
		return mounts.map((mount) => ({
			name: mount.name,
			target: mount.target,
			source: { kind: "host-path", path: join(storage.root, mount.name) },
		}));
	}

	async snapshot(
		ref: StorageRef,
		checkpointId: string,
		templateDigest: string,
		mounts: PersistenceMount[],
	): Promise<SnapshotResult> {
		await this.initRoots();
		const storage = this.storageRef(ref);
		const finalRoot = childOf(this.checkpointRoot, checkpointId);
		try {
			const manifest = CheckpointManifestSchema.parse(
				JSON.parse(await readFile(join(finalRoot, MANIFEST_FILE), "utf8")),
			);
			const manifestDigest = digestOf(manifest);
			return {
				ref: { kind: "filesystem", id: checkpointId, root: finalRoot },
				manifest,
				manifestDigest,
				storedBytes: manifest.logical_bytes,
			};
		} catch (error) {
			let finalExists = false;
			try {
				await lstat(finalRoot);
				finalExists = true;
			} catch {
				// Missing is the only case in which creation is allowed.
			}
			if (finalExists) {
				throw new Error("existing checkpoint content is invalid", {
					cause: error,
				});
			}
		}
		const temporaryRoot = join(this.checkpointRoot, `.creating-${checkpointId}`);
		await makeWritable(temporaryRoot).catch(() => {});
		await rm(temporaryRoot, { recursive: true, force: true });
		await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
		try {
			const manifestMounts: CheckpointManifest["mounts"] = [];
			let logicalBytes = 0;
			let fileCount = 0;
			for (const mount of mounts) {
				const source = join(storage.root, mount.name);
				const destination = join(temporaryRoot, mount.name);
				await mkdir(destination, { recursive: true, mode: 0o700 });
				const scanned = await scanMount(source, mount, destination);
				manifestMounts.push({ name: mount.name, entries: scanned.entries });
				logicalBytes += scanned.counters.bytes;
				fileCount += scanned.counters.files;
			}
			const manifest: CheckpointManifest = {
				format: "pocketcoder-checkpoint/v1",
				checkpoint_id: checkpointId,
				template_digest: templateDigest,
				mounts: manifestMounts,
				logical_bytes: logicalBytes,
				file_count: fileCount,
			};
			const manifestDigest = digestOf(manifest);
			const metadata: CheckpointMetadata = {
				format: "pocketcoder-checkpoint-metadata/v1",
				checkpoint_id: checkpointId,
				manifest_digest: manifestDigest,
			};
			await writeFile(join(temporaryRoot, MANIFEST_FILE), canonicalJson(manifest), {
				mode: 0o600,
			});
			await writeFile(join(temporaryRoot, CHECKPOINT_METADATA_FILE), canonicalJson(metadata), {
				mode: 0o600,
			});
			await makeReadOnly(temporaryRoot);
			await rename(temporaryRoot, finalRoot);
			return {
				ref: { kind: "filesystem", id: checkpointId, root: finalRoot },
				manifest,
				manifestDigest,
				storedBytes: logicalBytes,
			};
		} catch (error) {
			await makeWritable(temporaryRoot).catch(() => {});
			await rm(temporaryRoot, { recursive: true, force: true });
			throw error;
		}
	}

	async verifyCheckpoint(
		ref: CheckpointRef,
		expected: CheckpointManifest,
	): Promise<CheckpointManifest> {
		const checkpoint = this.checkpointRef(ref);
		const diskManifest = CheckpointManifestSchema.parse(
			JSON.parse(await readFile(join(checkpoint.root, MANIFEST_FILE), "utf8")),
		);
		if (digestOf(diskManifest) !== digestOf(expected)) {
			throw new Error("checkpoint manifest digest mismatch");
		}
		const contentProjection = (entries: CheckpointManifest["mounts"][number]["entries"]) =>
			entries.map((entry) => ({
				path: entry.path,
				kind: entry.kind,
				size: entry.size,
				digest: entry.digest,
				link_target: entry.link_target,
			}));
		let logicalBytes = 0;
		let fileCount = 0;
		for (const expectedMount of expected.mounts) {
			const maxBytes = expectedMount.entries.reduce((sum, entry) => sum + entry.size, 0);
			const scanned = await scanMount(join(checkpoint.root, expectedMount.name), {
				name: expectedMount.name,
				target: "/verification",
				maxBytes: Math.max(1, maxBytes),
				maxFiles: Math.max(1, expectedMount.entries.length),
			});
			if (
				canonicalJson(contentProjection(scanned.entries)) !==
				canonicalJson(contentProjection(expectedMount.entries))
			) {
				throw new Error("checkpoint content digest mismatch");
			}
			logicalBytes += scanned.counters.bytes;
			fileCount += scanned.counters.files;
		}
		if (logicalBytes !== expected.logical_bytes || fileCount !== expected.file_count) {
			throw new Error("checkpoint content digest mismatch");
		}
		return expected;
	}

	async cloneCheckpoint(
		checkpointRef: CheckpointRef,
		targetRef: StorageRef,
		manifest: CheckpointManifest,
	): Promise<void> {
		await this.verifyCheckpoint(checkpointRef, manifest);
		const checkpoint = this.checkpointRef(checkpointRef);
		const target = this.storageRef(targetRef);
		for (const mount of manifest.mounts) {
			const destination = join(target.root, mount.name);
			await rm(destination, { recursive: true, force: true });
			await mkdir(destination, { recursive: true, mode: 0o700 });
			await safeOwnership(
				destination,
				target.uid ?? process.getuid?.() ?? 1000,
				target.gid ?? process.getgid?.() ?? 1000,
				true,
			);
			const source = join(checkpoint.root, mount.name);
			for (const entry of mount.entries) {
				const from = join(source, entry.path);
				const to = join(destination, entry.path);
				if (entry.kind === "directory") {
					await mkdir(to, { recursive: true, mode: entry.mode });
				} else if (entry.kind === "file") {
					await mkdir(resolve(to, ".."), { recursive: true });
					await copyFile(from, to);
					await chmod(to, entry.mode);
					await chown(to, entry.uid, entry.gid).catch(async () => {
						await chmod(to, entry.mode | 0o006);
					});
					await setTimes(to, Number(BigInt(entry.mtime_ns) / 1_000_000n));
				} else {
					const linkTarget = entry.link_target;
					if (!linkTarget || !safeSymlinkTarget(entry.path, linkTarget)) {
						throw new Error("checkpoint manifest contains an unsafe symlink");
					}
					await mkdir(resolve(to, ".."), { recursive: true });
					await symlink(linkTarget, to);
					await lchown(to, entry.uid, entry.gid).catch(() => {});
					await setLinkTimes(to, Number(BigInt(entry.mtime_ns) / 1_000_000n));
				}
			}
			for (const entry of [...mount.entries].reverse()) {
				if (entry.kind !== "directory") continue;
				const to = join(destination, entry.path);
				let mode = entry.mode;
				await chown(to, entry.uid, entry.gid).catch(() => {
					mode |= 0o007;
				});
				await chmod(to, mode);
				await setTimes(to, Number(BigInt(entry.mtime_ns) / 1_000_000n));
			}
		}
	}

	async deleteStorage(ref: StorageRef): Promise<void> {
		const storage = this.storageRef(ref);
		await rm(storage.root, { recursive: true, force: true });
	}

	async deleteCheckpoint(ref: CheckpointRef): Promise<void> {
		const checkpoint = this.checkpointRef(ref);
		await makeWritable(checkpoint.root).catch(() => {});
		await rm(checkpoint.root, { recursive: true, force: true });
	}

	async listStorage(): Promise<DiscoveredStorage[]> {
		await this.initRoots();
		const result: DiscoveredStorage[] = [];
		for (const id of await readdir(this.workspaceRoot)) {
			if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
			const root = childOf(this.workspaceRoot, id);
			try {
				const metadata = JSON.parse(
					await readFile(join(root, STORAGE_METADATA_FILE), "utf8"),
				) as StorageMetadata;
				result.push({
					storageId: id,
					workspaceId: metadata.workspace_id ?? null,
					ref: { kind: "filesystem", id, root },
				});
			} catch {
				result.push({
					storageId: id,
					workspaceId: null,
					ref: { kind: "filesystem", id, root },
				});
			}
		}
		return result;
	}

	async listCheckpoints(): Promise<DiscoveredCheckpoint[]> {
		await this.initRoots();
		const result: DiscoveredCheckpoint[] = [];
		for (const id of await readdir(this.checkpointRoot)) {
			if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
			const root = childOf(this.checkpointRoot, id);
			try {
				const handle = await open(join(root, CHECKPOINT_METADATA_FILE), "r");
				await handle.close();
				result.push({
					checkpointId: id,
					ref: { kind: "filesystem", id, root },
				});
			} catch {
				// Incomplete/unknown physical content is intentionally not
				// adopted as a checkpoint.
			}
		}
		return result;
	}
}
