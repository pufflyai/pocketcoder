import { join } from "node:path";
import { parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import { command } from "../e2e/local-process";

export async function loadNativeFixture(directory: string, imageTag: string) {
  const template = parseTemplateManifest(await Bun.file(join(directory, "templates/echo.json")).json());
  await command(["docker", "load", "--input", join(directory, "echo-image.tar")], { quiet: true });
  const digest = template.manifest.spec.image.split("@")[1];
  if (!digest) throw new Error("Downloaded fixture must pin its image digest");
  await command(["docker", "tag", digest, imageTag], { quiet: true });
  const loaded = await command(["docker", "image", "inspect", "--format", "{{.Id}}", imageTag], { quiet: true });
  if (loaded.stdout.trim() !== digest) throw new Error("Downloaded fixture image differs");
  const image = `${imageTag}@${digest}`;
  template.manifest.spec.image = image;
  return { image, template: parseTemplateManifest(template.manifest) };
}
