import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function imageCommand(
  args: string[],
  options: { capture?: boolean; trim?: boolean; env?: Record<string, string | undefined> } = {},
) {
  const child = Bun.spawn(args, {
    env: options.env ?? process.env,
    stdout: options.capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const output = options.capture ? await new Response(child.stdout).text() : "";
  const code = await child.exited;
  if (code) throw new Error(`${args[0]} ${args[1]} exited ${code}`);
  return options.trim === false ? output : output.trim();
}

export async function imageFileHash(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function imageIdentity(tag: string) {
  const [image] = JSON.parse(await imageCommand(["docker", "image", "inspect", tag], { capture: true }));
  return {
    imageId: image.Id as string,
    bytes: image.Size as number,
    arch: image.Architecture as string,
    labels: image.Config.Labels as Record<string, string>,
  };
}
