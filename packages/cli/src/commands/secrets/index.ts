import { SecretPutRequestSchema } from "@pstdio/pocketcoder-contracts";
import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction, addResource } from "../command";

async function readInput(path: string) {
  const reader = (path === "-" ? Bun.stdin : Bun.file(path)).stream().getReader();
  const buffer = Buffer.alloc(65_536);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > buffer.byteLength)
        throw new Error("Stored secret input exceeds 65536 bytes.");
      buffer.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(buffer.subarray(0, size).toString());
  } catch {
    throw new Error("Invalid stored secret input.");
  }
  const result = SecretPutRequestSchema.safeParse(value);
  if (!result.success) throw new Error("Invalid stored secret input.");
  return result.data;
}

export function addSecretCommands(parser: Argv) {
  return addResource(parser, "secrets", "Manage encrypted controller secrets", (commands) => {
    const put = addAction(
      commands,
      "put <name>",
      "Store controller registry or setup issuer configuration",
      (command) =>
        command
          .positional("name", { type: "string", demandOption: true })
          .option("file", { type: "string", demandOption: true, description: "Protected JSON file, or - for stdin" }),
      async (flags) => {
        const input = await readInput(need(flags, "file"));
        console.log(JSON.stringify(await controlPlaneClient().secrets.put(need(flags, "name"), input)));
      },
    );
    const list = addAction(
      put,
      "list",
      "List instance-wide secret metadata",
      (command) => command.option("json", { type: "boolean", description: "Print JSON" }),
      async (flags) => {
        const items = await controlPlaneClient().secrets.list();
        if (flags.json) console.log(JSON.stringify(items));
        else
          for (const item of items)
            console.log(`${item.name}\t${item.type}\t${item.retired_at ? "retired" : "active"}\t${item.updated_at}`);
      },
    );
    return addAction(
      list,
      "retire <name>",
      "Stop new use of this reference",
      (command) => command.positional("name", { type: "string", demandOption: true }),
      async (flags) => {
        console.log(JSON.stringify(await controlPlaneClient().secrets.retire(need(flags, "name"))));
      },
    );
  });
}
