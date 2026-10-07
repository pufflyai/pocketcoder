// Owns public message admission and retains actual non-control handlers through shutdown.
import { type ServerFrame, ServerFrameSchema } from "@pstdio/pocketcoder-contracts";
import type { SupervisorWork } from "./supervisor-work";

export function supervisorMessageReceiver(owner: {
  isStopped(): boolean;
  handle(frame: ServerFrame): Promise<void>;
  work: SupervisorWork;
  log(message: string): void;
}) {
  return (raw: string): void => {
    const parsed = ServerFrameSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const control = parsed.data.type === "shutdown" || parsed.data.type === "signal";
    if (owner.isStopped() && !control) return;
    const operation = control ? owner.handle(parsed.data) : owner.work.run(() => owner.handle(parsed.data));
    void operation.catch((error) => owner.log(String(error)));
  };
}
