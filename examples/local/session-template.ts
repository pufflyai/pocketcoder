import { sessionTemplate, type TemplateManifest, type WorkloadTemplate } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { type LocalCommandRunner, runLocalCommand } from "./runtime";

// Template pins come from the installed image, never from a second copy of its code.
export async function imageSessionTemplate(
  image: string,
  name = "echo-harness",
  version = "2.0.0",
  command: LocalCommandRunner = runLocalCommand,
) {
  const descriptor = z
    .object({
      runtime: z.object({ digest: z.string() }),
      adapters: z.record(
        z.string(),
        z.object({ digest: z.string(), command: z.array(z.string()).min(1), cwd: z.string().optional() }),
      ),
    })
    .parse(
      JSON.parse(
        (
          await command(["docker", "run", "--rm", "--entrypoint", "cat", image, "/opt/pocketcoder/workload.json"], {
            quiet: true,
          })
        ).stdout,
      ),
    );
  const producer = descriptor.adapters.session;
  if (!producer || !producer.command) throw new Error("Image does not contain a native session producer");
  return sessionTemplate({
    name,
    version,
    image,
    runtimeDigest: descriptor.runtime.digest,
    producer: { digest: producer.digest, command: producer.command, ...(producer.cwd ? { cwd: producer.cwd } : {}) },
  });
}

export async function qualifySessionTemplate(
  source: TemplateManifest | WorkloadTemplate,
  image: string,
  command: LocalCommandRunner = runLocalCommand,
) {
  const template = await imageSessionTemplate(image, source.metadata.name, source.spec.version, command);
  template.metadata = source.metadata;
  template.spec.resources = source.spec.resources ?? template.spec.resources;
  template.spec.security = { ...template.spec.security, ...source.spec.security };
  const persistence =
    source.apiVersion === "pocketcoder.dev/v1" ? source.spec.lifecycle?.persistence : source.spec.persistence;
  const timeouts = source.apiVersion === "pocketcoder.dev/v1" ? source.spec.lifecycle?.timeouts : source.spec.timeouts;
  if (timeouts) template.spec.lifecycle!.timeouts = timeouts;
  if (persistence?.mounts?.length) {
    template.spec.lifecycle!.persistence = persistence;
    if (persistence.mounts.some((mount) => mount.target === "/state"))
      template.spec.services.session!.process!.env.POCKETCODER_SESSION_DIRECTORY = "/state/pocketcoder-sessions";
    template.spec.lifecycle!.checkpointHook = {
      command: ["/usr/local/bin/bun", "/opt/pocketcoder/quiesce.ts"],
      env: {},
      timeoutSeconds: 30,
    };
  }
  return template;
}
