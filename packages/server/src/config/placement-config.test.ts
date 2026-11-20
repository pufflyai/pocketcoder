import { expect, test } from "bun:test";
import { placementConfig } from "./placement-config";

test("maps existing scheduling to default and validates operator engine profiles", () => {
  expect(placementConfig({ POCKETCODER_KUBERNETES_RUNTIME_CLASS: "gvisor" }).placementProfiles.default).toEqual({
    runtimeClassName: "gvisor",
  });
  const config = {
    placementProfiles: {
      default: {},
      engine: { runtimeClassName: "kata-qemu", containerEngine: true, maxWorkspaces: 2 },
    },
    templatePlacement: { review: ["engine"] },
    vmRuntimeHandlers: ["kata-qemu"],
  };
  expect(placementConfig({ POCKETCODER_PLACEMENT_CONFIG: JSON.stringify(config) })).toEqual(config);
  config.vmRuntimeHandlers = ["gvisor"];
  expect(() => placementConfig({ POCKETCODER_PLACEMENT_CONFIG: JSON.stringify(config) })).toThrow("VM");
});
