import { checkResume } from "./check";
import { resumeInvocation } from "./launch";
import { checkReconnect } from "./reconnect-check";
import { IsolatedStack } from "./stack";
import { startSession } from "./start-session";

const stack = new IsolatedStack();
try {
  const { api, session, model, workspace } = await startSession(stack, 15, true);
  if (!model) throw new Error("Check model was not started");
  const control = session.controlServer();
  stack.cleanups.push(async () => control.close());
  const invocation = resumeInvocation({
    ...api,
    workspaceId: workspace.id,
    controlUrl: control.url,
    controlKey: control.key,
    check: true,
  });
  const child = Bun.spawn(invocation.command, {
    env: invocation.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await checkResume(child, session, model);
} finally {
  await stack.close();
}
await checkReconnect();
