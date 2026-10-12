export function serialAccountWork() {
  const claims = new Map<string, Promise<unknown>>();
  return {
    async run<T>(accountId: string, work: () => Promise<T>) {
      const previous = claims.get(accountId) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(work);
      claims.set(accountId, current);
      try {
        return await current;
      } finally {
        if (claims.get(accountId) === current) claims.delete(accountId);
      }
    },
    drain: () => Promise.allSettled([...claims.values()]),
  };
}
