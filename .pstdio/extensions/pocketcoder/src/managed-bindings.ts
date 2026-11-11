import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Which instance and managed session a Lab chat uses. It sits beside the machine chat bindings and
// holds only IDs; owner keys stay in the private instance folder.
export function managedBindings(projectId: string, root = join(homedir(), ".local", "share", "pocketcoder-pstdio")) {
  const file = (sessionId: string) => {
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error("Invalid Prompt Studio session ID.");
    return join(root, projectId, `${sessionId}.json`);
  };
  return {
    async bind(sessionId: string, instanceId: string, managedSessionId: string) {
      await writeFile(file(sessionId), JSON.stringify({ instanceId, managedSessionId }), { mode: 0o600 });
    },
    async target(sessionId: string) {
      const saved = JSON.parse(await readFile(file(sessionId), "utf8"));
      if (!saved.managedSessionId) throw new Error("This chat is not a managed PocketCoder session.");
      return saved as { instanceId: string; managedSessionId: string };
    },
  };
}
