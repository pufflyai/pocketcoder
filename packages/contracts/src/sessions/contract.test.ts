import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CollectionResultSchema } from "./collection";
import collections from "./fixtures/collection-v1.json";
import { ProfileConfigSchema, SessionCreateSchema } from "./profile";
import { RequestInputSchema } from "./request";

test("profiles supply usable defaults and session identities need an owner", () => {
  expect(ProfileConfigSchema.parse({ template: "agent" })).toEqual({
    template: "agent",
    placement: "exclusive",
    limits: { workspacesPerOwner: 1, sessionsPerWorkspace: 1 },
    dispatchDeadlineSeconds: 600,
  });
  expect(SessionCreateSchema.safeParse({ sessionId: randomUUID(), profile: "chat" }).success).toBe(false);
  expect(ProfileConfigSchema.safeParse({ template: "agent", limits: { workspacesPerOwner: 0 } }).success).toBe(false);
});
test("request text rejects invalid Unicode and counts UTF-8 bytes", () => {
  const input = { requestId: randomUUID(), attachments: [] };
  for (const message of ["\ud800", "\udc00", "😀".repeat(65537)])
    expect(RequestInputSchema.safeParse({ ...input, message }).success).toBe(false);
  expect(RequestInputSchema.safeParse({ ...input, message: "😀".repeat(65536) }).success).toBe(true);
});
test("collection distinguishes empty success, partial selection and loss", () => {
  for (const value of Object.values(collections)) expect(CollectionResultSchema.safeParse(value).success).toBe(true);
  expect(CollectionResultSchema.safeParse({ ...collections.lostBeforeAnyFile, errors: [] }).success).toBe(false);
  expect(CollectionResultSchema.safeParse({ ...collections.emptyComplete, errors: ["unexpected"] }).success).toBe(
    false,
  );
});
