import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { managed } from "@pstdio/pocketcoder-sdk";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { labScopes } from "./lab-keys";

// The Lab is an operator for its own controller. Sessions use the written consumer key.
export function managedConfiguration(
  directory: (id: string) => string,
  write: (id: string, file: string, value: unknown) => Promise<void>,
  cli: (id: string, args: string[]) => Promise<unknown>,
  url: (id: string) => Promise<string>,
  token: (id: string) => Promise<string>,
) {
  return {
    async configure(id: string, name: string, template: string, templateVersion: string) {
      const path = join(directory(id), "principals.json");
      const file = JSON.parse(await readFile(path, "utf8")) as {
        principals: { profiles: Record<string, managed.ProfileConfig> }[];
      };
      file.principals[0]!.profiles[name] = {
        template,
        templateVersion,
        placement: "shared",
        limits: { workspacesPerOwner: 4, sessionsPerWorkspace: 5 },
        dispatchDeadlineSeconds: 600,
      };
      await write(id, "principals.json", file);
      await cli(id, ["principals", "reconcile"]);
      return name;
    },
    async client(id: string) {
      return new PocketCoderClient({
        baseUrl: await url(id),
        apiKey: await token(id),
      });
    },
    async initialize(id: string) {
      const path = join(directory(id), "principals.json");
      if (await Bun.file(path).exists()) return;
      await write(id, "principals.json", {
        principals: [
          {
            name: "lab",
            scopes: labScopes,
            templates: ["*"],
            profiles: {},
          },
        ],
      });
    },
  };
}
