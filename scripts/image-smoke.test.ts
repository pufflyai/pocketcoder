import { expect, test } from "bun:test";
import { imageSmokeFlows, imageSmokeTests } from "./image-smoke";

test("image smoke runs only committed entry points", async () => {
  const missing = [];
  for (const file of [...Object.values(imageSmokeTests), ...Object.values(imageSmokeFlows)].flat())
    if (!(await Bun.file(file).exists())) missing.push(file);
  expect(missing).toEqual([]);
});
