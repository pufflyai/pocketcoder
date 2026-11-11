import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseWorkloadTemplate } from "@pstdio/pocketcoder-contracts";
import { qualifySessionTemplate } from "../local/session-template";

export async function nativeTemplate(image: string) {
  const source = parseWorkloadTemplate(
    JSON.parse(await readFile(resolve(import.meta.dir, "../harnesses/echo/template.json"), "utf8")),
  ).manifest;
  source.spec.lifecycle!.persistence.mounts = [{ name: "work", target: "/work", maxBytes: 1024 * 1024, maxFiles: 100 }];
  return parseWorkloadTemplate(await qualifySessionTemplate(source, image));
}

if (import.meta.main) {
  const image = process.argv[2];
  const output = process.argv[3];
  if (!image || !output) throw new Error("Usage: template.ts <digest-pinned-image> <output.json>");
  const template = await nativeTemplate(image);
  await Bun.write(output, `${JSON.stringify(template.manifest, null, 2)}\n`);
}
