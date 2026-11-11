import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digestOf, parseWorkloadTemplate } from "@pstdio/pocketcoder-contracts";
import { readCiImage } from "./ci-images";
import { imageSessionTemplate } from "./session-template";
export interface LocalCommandResult {
  stdout: string;
  stderr: string;
}

export type LocalCommandRunner = (
  args: string[],
  options?: { cwd?: string; quiet?: boolean },
) => Promise<LocalCommandResult>;

export interface PreparePiRuntimeOptions {
  root?: string;
  sourceTemplate?: string;
  outputDir?: string;
  imageTag?: string;
  gatewayUrl: string;
  gatewayModel: string;
  gatewayProvider?: string;
  gatewayApi?: "openai-completions" | "openai-responses";
  command?: LocalCommandRunner;
}

export interface BuildLocalImageOptions {
  root: string;
  imageTag: string;
  context: string;
  dockerfile?: string;
  command?: LocalCommandRunner;
}

export async function runLocalCommand(
  args: string[],
  options: { cwd?: string; quiet?: boolean } = {},
): Promise<LocalCommandResult> {
  const child = Bun.spawn(args, {
    cwd: options.cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed (${exitCode}): ${stderr.trim().slice(0, 4000)}`);
  }
  if (!options.quiet && stdout.trim()) console.log(stdout.trim());
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function buildLocalImage(options: BuildLocalImageOptions): Promise<{ imageId: string; image: string }> {
  const command = options.command ?? runLocalCommand;
  const fixture = await readCiImage(options.context, options.dockerfile);
  const build = [
    "docker",
    "build",
    ...(options.dockerfile ? ["--file", options.dockerfile] : []),
    "--tag",
    options.imageTag,
    options.context,
  ];
  if (fixture) await command(["docker", "tag", fixture.tag, options.imageTag], { cwd: options.root });
  else await command(build, { cwd: options.root });
  const imageId = (
    await command(["docker", "image", "inspect", options.imageTag, "--format", "{{.Id}}"], {
      cwd: options.root,
      quiet: true,
    })
  ).stdout;
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new Error(`docker returned an invalid local image ID: ${imageId}`);
  }
  if (fixture && fixture.imageId !== imageId) throw new Error("Loaded CI image differs from its recorded image ID");
  return { imageId, image: `${options.imageTag}@${imageId}` };
}

export async function preparePiRuntime(options: PreparePiRuntimeOptions) {
  const root = resolve(options.root ?? resolve(import.meta.dir, "../.."));
  const command = options.command ?? runLocalCommand;
  const image = await buildLocalImage({
    root,
    imageTag: options.imageTag ?? "pocketcoder-pi:local",
    context: ".",
    dockerfile: "examples/harnesses/pi/Dockerfile",
    command,
  });
  const template = await imageSessionTemplate(image.image, "pi-harness", "2.0.0", command);
  template.spec.security.writableMemoryPaths = ["/tmp", "/home/agent", "/workspace"];
  template.spec.credentialSlots.gateway = {
    policyRef: "pi-gateway",
    policyVersion: "1",
    binding: "fixed-scope",
    delivery: "workspace-expiring-file",
    maxLeaseSeconds: 7200,
  };
  template.spec.services.session!.process!.env = {
    HOME: "/home/agent",
    PI_GATEWAY_URL: options.gatewayUrl,
    PI_GATEWAY_MODEL: options.gatewayModel,
    PI_GATEWAY_PROVIDER: options.gatewayProvider ?? "pocketcoder-gateway",
    PI_GATEWAY_API: options.gatewayApi ?? "openai-completions",
    PI_GATEWAY_BEARER_FILE: "credentialSlot:gateway",
    PI_CODING_AGENT_DIR: "/home/agent/.pi/agent",
    PI_WORKSPACE_DIR: "/workspace",
  };
  template.spec.services.session!.process!.cwd = "/workspace";
  template.spec.version = `2.0.0-local.${digestOf(template).slice(7, 19)}`;
  const parsed = parseWorkloadTemplate(template);
  const outputDir = resolve(options.outputDir ?? resolve(root, ".pocketcoder/local/templates"));
  await mkdir(outputDir, { recursive: true });
  const templatePath = resolve(outputDir, "pi-harness.json");
  await writeFile(templatePath, JSON.stringify(parsed.manifest, null, 2) + "\n");
  return {
    templatePath,
    templateName: template.metadata.name,
    templateVersion: template.spec.version,
    templateDigest: parsed.digest,
    image: image.image,
  };
}
