import { expect, test } from "bun:test";
import { canonicalJson } from "../common/canonical";
import { fingerprintRequest } from "./fingerprint";
import vectors from "./fixtures/fingerprints-v1.json";

test("matches portable UTF-8 canonical JSON and SHA-256 vectors", () => {
  for (const vector of vectors) {
    expect(canonicalJson(vector.input), vector.name).toBe(vector.canonicalJson);
    expect(fingerprintRequest(vector.input), vector.name).toBe(vector.fingerprint);
    expect(fingerprintRequest(Object.fromEntries(Object.entries(vector.input).reverse()))).toBe(vector.fingerprint);
  }
  expect(new Set(vectors.map((v) => v.fingerprint)).size).toBe(vectors.length);
});

test("fingerprinting rejects invalid Unicode and fractional profile revisions", () => {
  expect(() => fingerprintRequest({ ...vectors[0]?.input, message: "\ud800" })).toThrow();
  expect(() => fingerprintRequest({ ...vectors[0]?.input, profileRevision: 1.5 })).toThrow();
});
