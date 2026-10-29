import type { createDestinationCustody } from "./destination-custody";

export function createDestinationPathIndex(ledger: Awaited<ReturnType<typeof createDestinationCustody>>) {
  // Only immutable index ordinals are reused. Keep one path, bounded by entry size.
  let previousMount = -1;
  let previousParts: string[] = [];
  let previousOrdinals: number[] = [];
  return {
    parents(mount: number, parts: string[]) {
      let shared = mount === previousMount;
      let path = "";
      return {
        ordinal(position: number, component: string) {
          path = path ? `${path}/${component}` : component;
          shared = shared && previousParts[position] === component;
          if (shared && previousOrdinals[position] !== undefined) return previousOrdinals[position];
          return ledger.ordinal(mount, path);
        },
        retain(ordinals: number[]) {
          previousMount = mount;
          previousParts = parts;
          previousOrdinals = ordinals;
        },
      };
    },
  };
}
