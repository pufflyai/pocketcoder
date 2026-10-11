import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeController } from "../examples/native/controller";

const [binary] = process.argv.slice(2);
if (!binary) throw new Error("Usage: native-startup-runner.ts <instrumented-executable>");
const directory = await mkdtemp(join(tmpdir(), "pc105-startup-profile-"));
const controller = await nativeController(binary, directory);
try {
  await controller.run(["--version"]);
  await controller.start();
  await controller.stop();
  await controller.start();
  await controller.stop();
  console.log(JSON.stringify({ qualification: "Diagnostic only", measurements: controller.measurements }));
} catch (error) {
  console.error(
    JSON.stringify({
      qualification: "Diagnostic only",
      error: String(error).split("\n")[0],
      measurements: controller.measurements,
    }),
  );
  process.exitCode = 1;
} finally {
  await controller.stop();
  await rm(directory, { recursive: true, force: true });
}
