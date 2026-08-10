import type {
  CheckpointManifest,
  PersistenceMount,
  PoolProviderInput,
  ProviderInput,
  TemplateSnapshot,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "./types";

// The single workspace-driver contract. Docker (development) and Kubernetes
// (production) implement the same interface; deployment configuration selects
// exactly one driver. Neither templates nor callers can select it.

export interface ProviderRef {
  kind: string;
  id: string;
  [key: string]: unknown;
}

export interface WorkspaceLaunch {
  workspace: WorkspaceRow;
  input: ProviderInput;
  mounts: RuntimeMountRef[];
  secrets: RuntimeSecretRef[];
}

export interface ProviderState {
  exists: boolean;
  running: boolean;
  exitCode: number | null;
  detail?: string;
}

export interface DiscoveredProvider {
  workspaceId: string;
  templateDigest: string;
  ref: ProviderRef;
}

export interface WarmRuntimeLaunch {
  runtimeId: string;
  template: TemplateSnapshot;
  input: PoolProviderInput;
  expiresAt: Date;
}

export interface DiscoveredWarmProvider {
  runtimeId: string;
  templateDigest: string;
  ref: ProviderRef;
}

export interface WorkspaceDriver {
  readonly kind: string;
  create(launch: WorkspaceLaunch): Promise<ProviderRef>;
  createWarm(launch: WarmRuntimeLaunch): Promise<ProviderRef>;
  inspect(ref: ProviderRef): Promise<ProviderState>;
  // Runtime stop and object deletion are separate so persistence workflows
  // can snapshot a quiesced workload before deleting the provider object.
  stop(ref: ProviderRef, graceSeconds: number): Promise<void>;
  remove(ref: ProviderRef): Promise<void>;
  // Every provider object labeled as a pocketcoder workspace, for
  // restart reconciliation and quarantine of unknown objects.
  list(): Promise<DiscoveredProvider[]>;
  listWarm(): Promise<DiscoveredWarmProvider[]>;
  cleanupWarmInput?(runtimeId: string): Promise<void>;
}

// Runtime mount refs are internal driver-neutral capabilities. Docker consumes
// host-path sources; a Kubernetes adapter consumes PVC sources. Public APIs
// and template manifests never contain either physical form.
export type RuntimeMountSource =
  | { kind: "host-path"; path: string }
  | { kind: "pvc"; claimName: string; subPath?: string };

export interface RuntimeMountRef {
  name: string;
  target: string;
  source: RuntimeMountSource;
  readOnly?: boolean;
}

export interface RuntimeSecretRef {
  name: string;
  target: string;
  source:
    | { kind: "host-path"; path: string }
    | { kind: "kubernetes-secret"; secretName: string; key: string };
}

export interface WorkspaceSecretResolver {
  // Runtime credentials remain workspace-readable files. Source credentials
  // use the separate setup-only value contract and are never mounted.
  resolve(workspace: WorkspaceRow): Promise<RuntimeSecretRef[]>;
  resolveSourceCredential(workspace: WorkspaceRow): Promise<string | null>;
}

export interface StorageRef {
  kind: string;
  id: string;
  [key: string]: unknown;
}

export interface CheckpointRef {
  kind: string;
  id: string;
  [key: string]: unknown;
}

export interface StorageAllocation {
  storageId: string;
  workspaceId: string;
  mounts: PersistenceMount[];
  uid: number;
  gid: number;
}

export interface AllocatedStorage {
  ref: StorageRef;
  mounts: RuntimeMountRef[];
}

export interface SnapshotResult {
  ref: CheckpointRef;
  manifest: CheckpointManifest;
  manifestDigest: string;
  storedBytes: number;
}

export interface DiscoveredStorage {
  storageId: string;
  workspaceId: string | null;
  ref: StorageRef;
}

export interface DiscoveredCheckpoint {
  checkpointId: string;
  ref: CheckpointRef;
}

export interface WorkspaceStorageDriver {
  readonly kind: string;
  allocate(input: StorageAllocation): Promise<AllocatedStorage>;
  runtimeMounts(ref: StorageRef, mounts: PersistenceMount[]): Promise<RuntimeMountRef[]>;
  cloneCheckpoint(
    checkpoint: CheckpointRef,
    target: StorageRef,
    manifest: CheckpointManifest,
  ): Promise<void>;
  snapshot(
    storage: StorageRef,
    checkpointId: string,
    templateDigest: string,
    mounts: PersistenceMount[],
  ): Promise<SnapshotResult>;
  verifyCheckpoint(ref: CheckpointRef, expected: CheckpointManifest): Promise<CheckpointManifest>;
  deleteStorage(ref: StorageRef): Promise<void>;
  deleteCheckpoint(ref: CheckpointRef): Promise<void>;
  listStorage(): Promise<DiscoveredStorage[]>;
  listCheckpoints(): Promise<DiscoveredCheckpoint[]>;
}
