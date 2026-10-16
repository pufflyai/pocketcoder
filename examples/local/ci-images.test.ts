import { expect, test } from "bun:test";
import { selectCiImage } from "./ci-images";

const image = {
  context: "deploy/image",
  dockerfile: "deploy/image/Dockerfile",
  commit: "a".repeat(40),
  tag: "ci-workspace:checked",
  imageId: `sha256:${"b".repeat(64)}`,
};

test("CI fixtures are selected by the actual build recipe and exact source revision", () => {
  expect(selectCiImage([image], image.commit, image.context)).toEqual(image);
  expect(() => selectCiImage([image], "c".repeat(40), image.context)).toThrow("source revision");
  expect(() => selectCiImage([image], image.commit, ".", "other.Dockerfile")).toThrow("recipe");
});
