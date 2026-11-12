import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseWorkloadTemplate } from "@pstdio/pocketcoder-contracts";
import { loadNativeFixture } from "../native/fixture";
import { nativeTemplate } from "../native/template";
import { buildLocalImage, runLocalCommand } from "./runtime";
import { imageSessionTemplate } from "./session-template";

const root = resolve(import.meta.dir, "../..");
const tag = `pocketcoder-session-template:test-${randomUUID()}`;
const loadedTag = `${tag}-loaded`;
const archiveTag = `${tag}-archive`;
let image: Awaited<ReturnType<typeof buildLocalImage>>;
let archiveImageId: string;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pc-session-template-"));
  await runLocalCommand(
    [process.execPath, "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"],
    { cwd: root, quiet: true },
  );
  await runLocalCommand([process.execPath, "run", "build:native"], { cwd: root, quiet: true });
  image = await buildLocalImage({ root, imageTag: tag, context: "deploy/image" });
  // Archive loading verifies identity and template parsing; it needs no runtime binaries.
  await writeFile(join(directory, "Dockerfile"), "FROM scratch\nCOPY marker /fixture\n");
  await writeFile(join(directory, "marker"), "native archive fixture\n");
  await runLocalCommand(["docker", "build", "--tag", archiveTag, directory], { quiet: true });
  archiveImageId = (
    await runLocalCommand(["docker", "image", "inspect", archiveTag, "--format", "{{.Id}}"], { quiet: true })
  ).stdout;
}, 60_000);

afterAll(async () => {
  await runLocalCommand(["docker", "image", "rm", tag, loadedTag, archiveTag], { quiet: true }).catch(() => {});
  await rm(directory, { recursive: true, force: true });
});

test("reads the installed session descriptor by immutable local image ID", async () => {
  const calls: string[][] = [];
  const template = await imageSessionTemplate(image.image, "native-fixture", "1.0.0", async (args, options) => {
    calls.push(args);
    return runLocalCommand(args, options);
  });
  expect(calls).toContainEqual([
    "docker",
    "run",
    "--rm",
    "--entrypoint",
    "cat",
    image.imageId,
    "/opt/pocketcoder/workload.json",
  ]);
  expect(template.spec.image).toBe(image.image);
  expect(parseWorkloadTemplate(template).manifest.spec.services.session?.process?.command.length).toBeGreaterThan(0);
});

test("native checkpoint templates use the installed structured producer and canonical persistence", async () => {
  const parsed = await nativeTemplate(image.image);
  const installed = await imageSessionTemplate(image.image);
  expect(parsed.manifest.apiVersion).toBe("pocketcoder.dev/v1");
  expect(parsed.manifest.spec.runtime).toEqual(installed.spec.runtime);
  expect(parsed.manifest.spec.adapters).toEqual(installed.spec.adapters);
  expect(parsed.manifest.spec.lifecycle?.persistence.mounts).toEqual([
    { name: "work", target: "/work", maxBytes: 1024 * 1024, maxFiles: 100 },
  ]);
  expect(parsed.manifest.spec.lifecycle?.checkpointHook?.command).toContain("/opt/pocketcoder/quiesce.ts");
});

test("native fixture archives reload canonical templates without changing image identity", async () => {
  const manifest = await imageSessionTemplate(image.image);
  manifest.spec.image = `${archiveTag}@${archiveImageId}`;
  await mkdir(join(directory, "templates"));
  await writeFile(join(directory, "templates/echo.json"), JSON.stringify(manifest));
  await runLocalCommand(["docker", "save", "--output", join(directory, "echo-image.tar"), archiveTag], { quiet: true });
  await runLocalCommand(["docker", "image", "rm", archiveTag], { quiet: true });
  const loaded = await loadNativeFixture(directory, loadedTag);
  expect(loaded.image).toBe(`${loadedTag}@${archiveImageId}`);
  expect(loaded.template.manifest).toEqual({ ...manifest, spec: { ...manifest.spec, image: loaded.image } });
});

test("the isolated native controller provides qualified input storage for structured sessions", async () => {
  const parentArtifact = Buffer.alloc(process.platform === "linux" ? 512_000_000 : 1, 1);
  // The shell gives the fixture its own Linux RSS history before it starts the measured controller.
  const checked = await runLocalCommand(
    [
      "sh",
      "-c",
      '"$@"',
      "pc-native-session",
      process.execPath,
      join(root, "examples/native/session-fixture.ts"),
      join(root, "out/native/pocketcoder"),
      image.image,
    ],
    { quiet: true },
  );
  const result = JSON.parse(checked.stdout);
  expect(result.state).toBe("ready");
  expect(result.starts[0].peakMemoryBytes).toBeLessThanOrEqual(512_000_000);
  expect(parentArtifact[0]).toBe(1);
}, 30_000);
