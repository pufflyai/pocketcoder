type Admission = { keys: Set<string>; unresolved: boolean; promise: Promise<unknown> };

export function admittedWork() {
  const pending = new Set<Admission>();
  return {
    run<T>(keys: string[], unresolved: boolean, work: (resolve: (keys: string[]) => void) => Promise<T>) {
      const admission: Admission = { keys: new Set(keys), unresolved, promise: Promise.resolve() };
      const current = Promise.resolve()
        .then(() =>
          work((resolved) => {
            for (const key of resolved) admission.keys.add(key);
            admission.unresolved = false;
          }),
        )
        .finally(() => {
          pending.delete(admission);
        });
      admission.promise = current;
      pending.add(admission);
      return current;
    },
    async settle(keys: string[]) {
      // Capture once: later unrelated calls must not keep this account's purge alive.
      const current = [...pending].filter((item) => item.unresolved || keys.some((key) => item.keys.has(key)));
      await Promise.allSettled(current.map((item) => item.promise));
    },
  };
}
