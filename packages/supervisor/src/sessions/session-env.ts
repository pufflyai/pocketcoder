import { existsSync } from "node:fs";
import { join } from "node:path";

const LEASES = "/run/pocketcoder/secrets/leases";

// Shared compute holds one lease folder per session. A session's turn gets its own folder in place
// of the workspace paths; a conversation without one keeps the workspace credentials.
export function sessionEnvironment(env: Record<string, string | undefined>, sessionId: string, root = LEASES) {
  const own = join(root, "sessions", sessionId);
  if (!existsSync(own)) return env;
  const prefix = `${root}/`;
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      const name = value?.startsWith(prefix) ? value.slice(prefix.length) : null;
      return [key, name && !name.includes("/") ? join(own, name) : value];
    }),
  );
}
