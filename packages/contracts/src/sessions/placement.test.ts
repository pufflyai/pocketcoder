import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { managedPlacement } from "./placement";
import { SessionProfileSchema } from "./profile";

test("sharing belongs to the principal, profile, owner, group and template release", () => {
  const principal = randomUUID(),
    session = { sessionId: randomUUID(), profile: "chat", owner: "alice", group: "client-a" };
  const profile = SessionProfileSchema.parse({
    name: "chat",
    template: "agent",
    templateVersion: "1",
    disabled: false,
    placement: "shared",
  });
  const key = managedPlacement(principal, session, profile).key;
  expect(managedPlacement(principal, { ...session, sessionId: randomUUID() }, profile).key).toBe(key);
  for (const next of [
    { ...session, owner: "bob" },
    { ...session, group: "client-b" },
    { ...session, profile: "other" },
  ])
    expect(managedPlacement(principal, next, profile).key).not.toBe(key);
  for (const next of [
    { ...profile, templateVersion: "2" },
    { ...profile, template: "other" },
    { ...profile, placement: "exclusive" as const },
  ])
    expect(managedPlacement(principal, session, next).key).not.toBe(key);
  expect(managedPlacement(randomUUID(), session, profile).key).not.toBe(key);
});
