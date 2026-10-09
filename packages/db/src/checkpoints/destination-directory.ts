import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CheckpointArchiveEntry, PersistenceMount } from "@pstdio/pocketcoder-contracts";
import { canonicalPathCheck } from "../database/canonical-path";
import { closeDestinationDescriptor } from "./destination-close";
import {
  assertDestinationCustody,
  assertDestinationIdentity,
  type createDestinationCustody,
  destinationCustody,
} from "./destination-custody";
import {
  destinationChmod,
  destinationMkdir,
  destinationOpen,
  destinationOpenDirectorySelf,
  destinationStat,
  destinationUnlink,
} from "./destination-native";
import { createDestinationPathIndex } from "./destination-path-index";
import { assertDestinationPrivateAcl } from "./destination-privacy";
import { createNativeDirectory } from "./native-directory";

export interface DestinationMount {
  parent: string;
  policy: PersistenceMount;
}
type Ledger = Awaited<ReturnType<typeof createDestinationCustody>>;
function openCapturedDirectory(parent: number, name: string, expected: Buffer) {
  const descriptor = destinationOpen(parent, name, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    assertDestinationCustody(fstatSync(descriptor, { bigint: true }), expected);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
function closeChild(descriptor: number, root: number) {
  if (descriptor !== root) closeSync(descriptor);
}
function openPrivate(path: string) {
  let descriptor = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const name of path.split("/").filter(Boolean)) {
      const next = destinationOpen(descriptor, name, constants.O_RDONLY | constants.O_DIRECTORY);
      closeSync(descriptor);
      descriptor = next;
    }
    const stat = fstatSync(descriptor, { bigint: true });
    if ((stat.mode & 0o7777n) !== 0o700n || stat.uid !== BigInt(process.getuid?.() ?? 0))
      throw new Error("Checkpoint destination parent must be private and owned.");
    assertDestinationPrivateAcl(descriptor);
    const canonical = canonicalPathCheck(path, path, descriptor);
    if (!canonical()) throw new Error("Checkpoint destination parent is not canonical.");
    return { descriptor, path, expected: destinationCustody(stat), canonical, names: new Set<string>() };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
export function destinationNames(descriptor: number) {
  const held = destinationOpenDirectorySelf(descriptor);
  let directory: ReturnType<typeof createNativeDirectory>;
  try {
    directory = createNativeDirectory(held);
  } catch (error) {
    closeSync(held);
    throw error;
  }
  return {
    next() {
      let name = directory.read();
      while (name === "." || name === "..") name = directory.read();
      return name;
    },
    close: () => directory.close(),
  };
}
export function openDestinationParents(mounts: readonly DestinationMount[]) {
  const parents = new Map<string, ReturnType<typeof openPrivate>>();
  try {
    for (const mount of mounts) {
      const path = resolve(mount.parent);
      if (parents.has(path)) continue;
      const parent = openPrivate(path);
      parents.set(path, parent);
      const names = destinationNames(parent.descriptor);
      try {
        if (names.next() !== undefined) throw new Error("Checkpoint destination parent must be empty.");
      } finally {
        names.close();
      }
    }
    return parents;
  } catch (error) {
    for (const parent of parents.values()) closeSync(parent.descriptor);
    throw error;
  }
}
export function createDestinationDirectories(
  mounts: readonly DestinationMount[],
  parents: ReturnType<typeof openDestinationParents>,
  ledger: Ledger,
  check: () => void,
) {
  const stages: {
    descriptor: number;
    name: string;
    path: string;
    expected: Buffer;
    parent: ReturnType<typeof openPrivate>;
    removed: boolean;
  }[] = [];
  let publishedRoots = false;
  const pathIndex = createDestinationPathIndex(ledger);
  function validateNative() {
    ledger.validate();
    for (const parent of parents.values()) {
      assertDestinationCustody(fstatSync(parent.descriptor, { bigint: true }), parent.expected);
      if (!parent.canonical()) throw new Error("Checkpoint destination parent custody changed.");
    }
    for (const stage of stages) {
      assertDestinationCustody(fstatSync(stage.descriptor, { bigint: true }), stage.expected);
      if (!stage.removed)
        assertDestinationCustody(destinationStat(stage.parent.descriptor, stage.name), stage.expected);
    }
  }
  function validate() {
    check();
    validateNative();
  }
  function createStages() {
    for (const mount of mounts) {
      validate();
      const parent = parents.get(resolve(mount.parent));
      if (!parent) throw new Error("Checkpoint destination parent is not held.");
      const name = `.checkpoint-stage-${randomUUID()}`;
      destinationMkdir(parent.descriptor, name);
      parent.expected = destinationCustody(fstatSync(parent.descriptor, { bigint: true }));
      const descriptor = destinationOpen(parent.descriptor, name, constants.O_RDONLY | constants.O_DIRECTORY);
      stages.push({
        descriptor,
        removed: false,
        name,
        path: join(parent.path, name),
        parent,
        expected: destinationCustody(fstatSync(descriptor, { bigint: true })),
      });
      parent.names.add(name);
      fsyncSync(parent.descriptor);
      validateNative();
    }
  }
  function validateWalk(root: number, parts: string[], ordinals: number[]) {
    let walking = root;
    try {
      for (const [position, component] of parts.entries()) {
        const ordinal = ordinals[position];
        if (ordinal === undefined) throw new Error("Checkpoint destination ancestor is not admitted.");
        const expected = ledger.read(ordinal).subarray(8, 72);
        assertDestinationCustody(destinationStat(walking, component), expected);
        const next = openCapturedDirectory(walking, component, expected);
        if (walking !== root) closeSync(walking);
        walking = next;
      }
    } finally {
      if (walking !== root) closeSync(walking);
    }
  }
  async function openParent(entry: CheckpointArchiveEntry) {
    validate();
    const root = stages[entry.mount];
    if (!root) throw new Error("Checkpoint destination mount is not admitted.");
    const parts = entry.path.split("/");
    const name = parts.pop();
    if (!name) throw new Error("Checkpoint destination name is missing.");
    const rootDescriptor = publishedRoots ? root.parent.descriptor : root.descriptor;
    let current = rootDescriptor;
    let ordinal: number | undefined;
    const ordinals: number[] = [];
    const ancestors = pathIndex.parents(entry.mount, parts);
    try {
      for (const [position, component] of parts.entries()) {
        const found = ancestors.ordinal(position, component);
        let nextOrdinal: number | null | undefined;
        if (typeof found === "number") nextOrdinal = found;
        else {
          nextOrdinal = await found;
        }
        check();
        if (nextOrdinal === null || nextOrdinal === undefined)
          throw new Error("Checkpoint destination parent is not admitted.");
        const slot = ledger.read(nextOrdinal);
        if (!slot[0]) throw new Error("Checkpoint destination parent is not created.");
        assertDestinationCustody(destinationStat(current, component), slot.subarray(8, 72));
        const next = openCapturedDirectory(current, component, slot.subarray(8, 72));
        closeChild(current, rootDescriptor);
        current = next;
        ordinal = nextOrdinal;
        ordinals.push(nextOrdinal);
      }
      // Component custody is checked at each open. Prove all held roots once
      // after the last await/caller callback, before returning this parent.
      validateNative();
      ancestors.retain(ordinals);
      return {
        descriptor: current,
        name,
        ordinal,
        refresh() {
          const stat = fstatSync(current, { bigint: true });
          if (ordinal === undefined) {
            const held = publishedRoots ? root.parent : root;
            assertDestinationIdentity(stat, held.expected);
            held.expected = destinationCustody(stat);
          } else {
            const slot = ledger.read(ordinal);
            assertDestinationIdentity(stat, slot.subarray(8, 72));
            ledger.retain(ordinal, stat, slot.readUInt8(0));
          }
        },
        validateNative() {
          validateNative();
          // Recheck closed ancestors without caller callbacks or another FD stack.
          validateWalk(rootDescriptor, parts, ordinals);
          let expected = publishedRoots ? root.parent.expected : root.expected;
          if (ordinal !== undefined) expected = ledger.read(ordinal).subarray(8, 72);
          assertDestinationCustody(fstatSync(current, { bigint: true }), expected);
        },
        close() {
          closeChild(current, rootDescriptor);
        },
      };
    } catch (error) {
      closeChild(current, rootDescriptor);
      throw error;
    }
  }
  return {
    stages,
    usePublishedRoots(value: boolean) {
      publishedRoots = value;
    },
    createStages,
    validate,
    validateNative,
    openParent,
    sync(flush: (descriptor: number) => void = fsyncSync) {
      for (const held of [...stages, ...parents.values()]) {
        validateNative();
        flush(held.descriptor);
        validateNative();
      }
    },
    async validateParents(entry: CheckpointArchiveEntry) {
      const parent = await openParent(entry);
      try {
        parent.validateNative();
      } finally {
        parent.close();
      }
    },
    closeDescriptors() {
      const errors: unknown[] = [];
      for (const stage of stages) {
        try {
          closeDestinationDescriptor(stage.descriptor, stage.expected);
        } catch (error) {
          errors.push(error);
        }
      }
      for (const parent of parents.values()) {
        try {
          closeDestinationDescriptor(parent.descriptor, parent.expected);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw errors[0];
    },
    removeStages() {
      validateNative();
      for (const stage of stages) {
        if (stage.removed) continue;
        destinationUnlink(stage.parent.descriptor, stage.name, true);
        stage.removed = true;
        stage.expected = destinationCustody(fstatSync(stage.descriptor, { bigint: true }));
        stage.parent.names.delete(stage.name);
        stage.parent.expected = destinationCustody(fstatSync(stage.parent.descriptor, { bigint: true }));
        fsyncSync(stage.parent.descriptor);
      }
    },
    async restoreSearch(entry: CheckpointArchiveEntry, ordinal: number) {
      const slot = ledger.read(ordinal);
      if (!slot[0]) return;
      const parent = await openParent(entry);
      try {
        assertDestinationCustody(destinationStat(parent.descriptor, parent.name), slot.subarray(8, 72));
        destinationChmod(parent.descriptor, parent.name, 0o700);
        const stat = destinationStat(parent.descriptor, parent.name);
        assertDestinationIdentity(stat, slot.subarray(8, 72));
        ledger.retain(ordinal, stat, slot.readUInt8(0));
        parent.validateNative();
      } finally {
        parent.close();
      }
    },
  };
}
