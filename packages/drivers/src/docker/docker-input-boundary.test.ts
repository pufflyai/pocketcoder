import { expect, test } from "bun:test";
import { assertInputMountTable } from "./docker-input-boundary";

// Linux mountinfo fields include the actual resolved target and filesystem root.
const rootfs = "1 0 0:1 / / ro - overlay overlay rw";
const projection = "2 1 0:2 /private/inputs/scope /run/pocketcoder/inputs ro - ext4 /dev/vdb rw";
test("kernel mount evidence rejects target symlinks, nested mounts and bind aliases", () => {
  const target = "/run/pocketcoder/inputs";
  expect(() => assertInputMountTable(`${rootfs}\n${projection}`, target, [])).not.toThrow();
  expect(() =>
    assertInputMountTable(`${rootfs}\n${projection}\n3 1 0:8 /canonical /work rw - ext4 /dev/vdc rw`, target, [
      { device: "0:8", root: "/canonical" },
    ]),
  ).toThrow("private");
  for (const alias of [
    "3 1 0:3 /other /run/pocketcoder/inputs rw - ext4 /dev/vdc rw",
    "3 2 0:3 /other /run/pocketcoder/inputs/execution rw - ext4 /dev/vdc rw",
    "3 1 0:2 /private/inputs/scope /work rw - ext4 /dev/vdb rw",
    "3 1 0:2 /private/inputs /work ro - ext4 /dev/vdb rw",
    "3 1 0:2 /private/inputs/scope/child /work rw - ext4 /dev/vdb rw",
  ])
    expect(() => assertInputMountTable(`${rootfs}\n${projection}\n${alias}`, target, [])).toThrow();
});
