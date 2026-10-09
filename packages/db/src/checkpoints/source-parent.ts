import { fstatSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { openCheckpointDirectory } from "./directory-reader";
import type { createCheckpointEntrySorter } from "./entry-sort";
import { assertCheckpointCustody } from "./source-custody";

type CompleteIndex = Awaited<ReturnType<ReturnType<typeof createCheckpointEntrySorter>["seal"]>>;

export async function checkpointSourceParent(
  root: ReturnType<typeof openCheckpointDirectory>,
  mount: number,
  path: string,
  index: CompleteIndex,
  check: () => void,
) {
  const components = path.split("/");
  components.pop();
  // The archive's 16 KiB entry bound also bounds this per-payload custody buffer.
  // Keep stamps, rather than a descriptor stack, for already closed ancestors.
  const custody = Buffer.alloc(components.length * 64);
  let current = root;
  let relative = "";
  try {
    for (const [position, component] of components.entries()) {
      relative = relative ? `${relative}/${component}` : component;
      const record = await index.lookupRecord(mount, relative);
      check();
      root.validate();
      current.validate();
      if (record?.entry.kind !== "directory" || !record.custody)
        throw new Error("Checkpoint source parent is not captured.");
      record.custody.copy(custody, position * 64);
      const next = openCheckpointDirectory(join(root.path, relative), check);
      try {
        assertCheckpointCustody(fstatSync(next.descriptor, { bigint: true }), record.custody);
        current.validate();
        next.validate();
        root.validate();
      } catch (error) {
        next.close();
        throw error;
      }
      if (current !== root) current.close();
      current = next;
    }
    check();
    root.validate();
    current.validate();
    if (current === root) return root;
    function validateAncestors() {
      let path = root.path;
      for (const [position, component] of components.entries()) {
        path = join(path, component);
        assertCheckpointCustody(
          lstatSync(path, { bigint: true }),
          custody.subarray(position * 64, (position + 1) * 64),
        );
      }
    }
    function validateNative() {
      root.validateNative();
      current.validateNative();
      validateAncestors();
    }
    function validate() {
      root.validate();
      current.validate();
      validateNative();
    }
    validate();
    return { ...current, validate, validateNative };
  } catch (error) {
    if (current !== root) current.close();
    throw error;
  }
}
