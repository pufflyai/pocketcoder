import { ApiError } from "@pstdio/pocketcoder-contracts";

export function controlActivity(onFence: () => void) {
  const pending = new Set<Promise<unknown>>();
  let fenced = false;
  function track<T>(work: () => Promise<T>) {
    const task = Promise.resolve().then(work);
    pending.add(task);
    const remove = () => pending.delete(task);
    task.then(remove, remove);
    return task;
  }
  return {
    track,
    run<T>(work: () => Promise<T>) {
      if (fenced) return Promise.reject<T>(new ApiError("account.purged", "Account control traffic is fenced."));
      return track(work);
    },
    fence() {
      fenced = true;
      onFence();
    },
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
export type ControlActivity = ReturnType<typeof controlActivity>;
