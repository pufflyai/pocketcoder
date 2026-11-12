import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fingerprintRequest } from "./fingerprint";

test("replay fingerprints depend on message and attachment IDs", () => {
  const body = { requestId: randomUUID(), message: "hello", attachments: [randomUUID()] };
  const fingerprint = fingerprintRequest(body);
  expect(fingerprintRequest({ ...body, requestId: randomUUID() })).toBe(fingerprint);
  expect(fingerprintRequest({ ...body, message: "different" })).not.toBe(fingerprint);
  expect(fingerprintRequest({ ...body, attachments: [] })).not.toBe(fingerprint);
});
