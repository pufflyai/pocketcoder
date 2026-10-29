import { expect, test } from "bun:test";
import { managedPrincipalsConfig } from "./startup";

test("the principal file and dry run come from the environment", () => {
  expect(managedPrincipalsConfig({})).toBeUndefined();
  expect(managedPrincipalsConfig({ POCKETCODER_PRINCIPALS_FILE: "/etc/pc/principals.json" })).toEqual({
    file: "/etc/pc/principals.json",
    dryRun: false,
  });
  expect(
    managedPrincipalsConfig({ POCKETCODER_PRINCIPALS_FILE: "/p.json", POCKETCODER_PRINCIPALS_DRY_RUN: "true" }),
  ).toEqual({ file: "/p.json", dryRun: true });
  expect(() => managedPrincipalsConfig({ POCKETCODER_PRINCIPALS_DRY_RUN: "true" })).toThrow("requires");
  expect(() =>
    managedPrincipalsConfig({ POCKETCODER_PRINCIPALS_FILE: "/p.json", POCKETCODER_PRINCIPALS_DRY_RUN: "1" }),
  ).toThrow("true or false");
});
