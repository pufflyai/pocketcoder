import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { qualifySessionTemplate } from "../../local/session-template";

// Writes the remote-tests template for one built image. The runtime and adapter pins
// come from the image's own descriptor, read through the local Docker daemon.
//   bun examples/harnesses/test-runner/render-template.ts <repo@sha256:…> <out-dir>
const [image, out, variant] = process.argv.slice(2);
if (!image?.includes("@sha256:") || !out) throw new Error("usage: render-template.ts <repo@sha256:digest> <out-dir>");

const source = JSON.parse(
  await readFile(join(import.meta.dir, variant === "review" ? "review-template.json" : "template.json"), "utf8"),
);
const template = await qualifySessionTemplate(source, image);
template.spec.limits = source.spec.limits;
// Runtime metadata comes from the published image/template, never the run request.
template.spec.placement = source.spec.placement;
const producer = template.spec.services.session!.process!;
producer.env = {
  ...producer.env,
  POCKETCODER_RUNTIME_IMAGE: image,
  POCKETCODER_RUNTIME_PLACEMENT: source.spec.placement ?? "default",
};
await mkdir(out, { recursive: true });
const path = join(out, `${template.metadata.name}.json`);
await writeFile(path, `${JSON.stringify(template, null, 2)}\n`);
console.log(path);
