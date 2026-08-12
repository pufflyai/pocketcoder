import { describe, expect, test } from "bun:test";
import { advisoryLockKey, assertValidSchema } from "./database-schema";

describe("schema helpers", () => {
  test("schema names are validated before qualification", () => {
    expect(assertValidSchema("pocketcoder")).toBe("pocketcoder");
    expect(() => assertValidSchema('bad"; DROP SCHEMA public;')).toThrow();
    expect(() => assertValidSchema("Capitals")).toThrow();
  });

  test("advisory lock keys are stable per schema and distinct across schemas", () => {
    expect(advisoryLockKey("pocketcoder")).toBe(advisoryLockKey("pocketcoder"));
    expect(advisoryLockKey("pocketcoder")).not.toBe(advisoryLockKey("other_schema"));
  });
});
