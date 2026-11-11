import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceResourceSchema } from "@pstdio/pocketcoder-contracts";
import { runLocalCommand } from "../local/runtime";
import { nativeController } from "./controller";
import { nativeTemplate } from "./template";

const binary = process.argv[2];
const image = process.argv[3];
if (!binary || !image) throw new Error("Usage: session-fixture.ts <binary> <image>");
const directory = await mkdtemp(join(tmpdir(), "pc-native-session-"));
const templates = join(directory, "templates");
await mkdir(templates);
await writeFile(join(templates, "echo.json"), JSON.stringify((await nativeTemplate(image)).manifest));
const controller = await nativeController(binary, directory, true);
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
  const workspace = WorkspaceResourceSchema.parse(
    JSON.parse(await controller.run(["workspaces", "create", "--template", "echo-harness", "--wait", "--json"], token)),
  );
  id = workspace.id;
  await controller.run(["workspaces", "cancel", "--id", id], token);
  await controller.stop();
  console.log(JSON.stringify({ state: workspace.state, starts: controller.measurements }));
} finally {
  if (id) await controller.run(["workspaces", "cancel", "--id", id], token).catch(() => {});
  await controller.stop();
  if (id) await runLocalCommand(["docker", "rm", "--force", `pocketcoder-ws-${id}`], { quiet: true }).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
