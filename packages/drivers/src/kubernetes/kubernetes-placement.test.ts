import { expect, test } from "bun:test";
import { KubernetesPlacement } from "./kubernetes-placement";

test("keeps legacy scheduling as default and requires operator template permission", () => {
  const placement = new KubernetesPlacement(
    { default: { runtimeClassName: "gvisor" }, arm: { nodeSelector: { "kubernetes.io/arch": "arm64" } } },
    { review: ["arm"] },
  );
  expect(placement.resolve("other")).toEqual({ runtimeClassName: "gvisor" });
  expect(placement.resolve("review", "arm").nodeSelector).toEqual({ "kubernetes.io/arch": "arm64" });
  expect(() => placement.resolve("other", "arm")).toThrow("not allowed");
  expect(() => placement.resolve("review", "removed")).toThrow("unavailable");
});

test("refuses an engine profile outside a configured Kata VM handler", () => {
  expect(
    () =>
      new KubernetesPlacement({ default: {}, engine: { containerEngine: true, runtimeClassName: "gvisor" } }, {}, [
        "gvisor",
      ]),
  ).toThrow("VM");
  expect(
    () =>
      new KubernetesPlacement({ default: { containerEngine: true, runtimeClassName: "kata-qemu" } }, {}, ["kata-qemu"]),
  ).toThrow("default");
  const placement = new KubernetesPlacement(
    { default: {}, engine: { containerEngine: true, runtimeClassName: "kata-qemu" } },
    { review: ["engine"] },
    ["kata-qemu"],
  );
  expect(placement.resolve("review", "engine").containerEngine).toBe(true);
});

test("checks the actual handler instead of trusting the RuntimeClass name", async () => {
  const placement = new KubernetesPlacement(
    { default: {}, engine: { containerEngine: true, runtimeClassName: "kata-qemu" } },
    { review: ["engine"] },
    ["kata-qemu"],
  );
  const profile = placement.resolve("review", "engine");
  await expect(placement.verify(profile, async () => ({ handler: "runc" }))).rejects.toThrow("Kata VM handler");
  await placement.verify(profile, async () => ({ handler: "kata-qemu" }));
});

test("a RuntimeClass alias is qualified by its actual Kata handler", async () => {
  const placement = new KubernetesPlacement(
    { default: {}, engine: { containerEngine: true, runtimeClassName: "microvm" } },
    { review: ["engine"] },
    ["kata-clh"],
  );
  await placement.verify(placement.resolve("review", "engine"), async () => ({ handler: "kata-clh" }));
  await expect(
    placement.verify(placement.resolve("review", "engine"), async () => ({ handler: "runc" })),
  ).rejects.toThrow("Kata VM handler");
});
