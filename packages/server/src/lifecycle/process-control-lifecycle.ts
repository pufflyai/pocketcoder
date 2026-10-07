// Keeps process-owner control alive while the managed controller retains its coordinator lease.
import type { ServerConfig } from "../config/config";
import { startPocketCoderServer } from "./lifecycle";
import { startProcessControl } from "./process-control";

export async function runControlledPocketCoderServerUntilSignal(
  config: ServerConfig,
  options: {
    root: string;
    instanceId: string;
  },
) {
  const running = await startPocketCoderServer(config, { instanceId: options.instanceId });
  let control: Awaited<ReturnType<typeof startProcessControl>>;
  try {
    control = await startProcessControl({ running, ...options });
  } catch (error) {
    await running.stop();
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      // Close control first. Unknown userspace settlement must not release the store lease.
      void control
        .stop()
        .then(() => running.stop())
        .then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
