import type { AcceptedInputManifest, InputObjectReference } from "@pstdio/pocketcoder-contracts";

export interface InputBackingRef {
  workspaceId: string;
  fileId: string;
  versionId: string;
}
export interface InputProjectionRef {
  kind: "immutable-inputs/v1";
  manifestId: string;
  manifest: AcceptedInputManifest;
  objects: { reference: InputObjectReference; backing: InputBackingRef }[];
}
export interface PublishedInputProjection {
  manifestId: string;
  digest: string;
  directory: string;
}
export interface InputProjectionStorage {
  profile: "controller-readonly/v1" | "shared-writer-readonly/v1";
  identity: string;
}
export interface InputByteWriter {
  write(bytes: Uint8Array): Promise<void>;
  publish(): Promise<void>;
  close(): Promise<void>;
}
export interface InputStorageDriver {
  create(ref: InputBackingRef): Promise<InputByteWriter>;
  verify(ref: InputBackingRef, expected: InputObjectReference): Promise<void>;
  read(ref: InputBackingRef, expected: InputObjectReference): Promise<ReadableStream<Uint8Array>>;
  remove(ref: InputBackingRef): Promise<void>;
  pruneEmpty(protectedRefs: InputBackingRef[]): Promise<void>;
  list(): Promise<InputBackingRef[]>;
}
