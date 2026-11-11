import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseWorkloadTemplate } from "@pstdio/pocketcoder-contracts";
import { nativeController } from "../native/controller";
import { loadNativeFixture } from "../native/fixture";
import { nativeTemplate } from "../native/template";
import { buildLocalImage, runLocalCommand } from "./runtime";
import { imageSessionTemplate } from "./session-template";

const root = resolve(import.meta.dir, "../..");
const tag = `pocketcoder-session-template:test-${randomUUID()}`;
const loadedTag = `${tag}-loaded`;
let image: Awaited<ReturnType<typeof buildLocalImage>>;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pc-session-template-"));
  await runLocalCommand(
    [process.execPath, "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"],
    { cwd: root, quiet: true },
  );
  await runLocalCommand([process.execPath, "run", "build:native"], { cwd: root, quiet: true });
  image = await buildLocalImage({ root, imageTag: tag, context: "deploy/image" });
}, 60_000);

afterAll(async () => {
  await runLocalCommand(["docker", "image", "rm", tag, loadedTag], { quiet: true }).catch(() => {});
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
  await mkdir(join(directory, "templates"));
  await writeFile(join(directory, "templates/echo.json"), JSON.stringify(manifest));
  await runLocalCommand(["docker", "save", "--output", join(directory, "echo-image.tar"), tag], { quiet: true });
  const loaded = await loadNativeFixture(directory, loadedTag);
  expect(loaded.image).toBe(`${loadedTag}@${image.imageId}`);
  expect(loaded.template.manifest).toEqual({ ...manifest, spec: { ...manifest.spec, image: loaded.image } });
});

test("the isolated native controller provides qualified input storage for structured sessions", async () => {
  const controllerDirectory = join(directory, "controller");
  const templates = join(controllerDirectory, "templates");
  await mkdir(templates, { recursive: true });
  await writeFile(join(templates, "echo.json"), JSON.stringify((await nativeTemplate(image.image)).manifest));
  const controller = await nativeController(join(root, "out/native/pocketcoder"), controllerDirectory, true);
  let id: string | undefined;
  let token: string | undefined;
  try {
    await controller.start();
    const owner = JSON.parse(
      await controller.run([
        "superuser",
        "create",
        "--automation",
        "--expires",
        new Date(Date.now() + 60_000).toISOString(),
        "--json",
      ]),
    );
    token = owner.token;
    await controller.run(["templates", "import", templates], token);
    const workspace = JSON.parse(
      await controller.run(["workspaces", "create", "--template", "echo-harness", "--wait", "--json"], token),
    );
    id = workspace.id;
    expect(workspace.state).toBe("ready");
  } finally {
    if (id) await controller.run(["workspaces", "cancel", "--id", id], token);
    await controller.stop();
    if (id) await runLocalCommand(["docker", "rm", "--force", `pocketcoder-ws-${id}`], { quiet: true }).catch(() => {});
  }
}, 30_000);
