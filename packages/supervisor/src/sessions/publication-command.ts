import { resolve } from "node:path";

export async function publishFileCommand(args: string[]) {
  if (args.includes("--help")) {
    console.log(
      "usage: pocketcoder-supervisor session publish-file --file <path> [--name <filename>] [--media-type <type>] [--id <uuid>]",
    );
    return;
  }
  const fields: Record<string, string> = {};
  const options: Record<string, string> = {
    "--file": "path",
    "--name": "name",
    "--media-type": "mediaType",
    "--id": "publicationId",
  };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? "";
    const key = Object.hasOwn(options, flag) ? options[flag] : undefined;
    const value = args[index + 1];
    if (!key || !value || fields[key]) throw new Error("Invalid publish-file option; use --help");
    fields[key] = value;
  }
  if (!fields.path) throw new Error("publish-file requires --file");
  const url = process.env.POCKETCODER_PUBLICATION_URL;
  const token = process.env.POCKETCODER_PUBLICATION_TOKEN;
  if (!url || !token) throw new Error("File publication is not enabled for this running request");
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
    throw new Error("Invalid local publication endpoint");
  const response = await fetch(target, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      ...fields,
      path: resolve(fields.path),
      mediaType: fields.mediaType ?? "application/octet-stream",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const receipt = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(receipt.error ?? "File publication failed");
  console.log(JSON.stringify(receipt));
}
