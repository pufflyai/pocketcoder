import { expect, test } from "bun:test";
import { artifactPath, PrivateArtifactSchema } from "./artifacts";

const transcripts = PrivateArtifactSchema.parse({
  name: "chat-transcripts",
  mount: "harness-state",
  pattern: "chats/*/transcript.jsonl",
});

test("a key fills the single wildcard segment", () => {
  expect(transcripts.maxBytes).toBe(8 * 1024 * 1024);
  expect(artifactPath(transcripts, "5fb0bfdb-5595-4a5f-aca1-22851cb18ff6")).toBe(
    "chats/5fb0bfdb-5595-4a5f-aca1-22851cb18ff6/transcript.jsonl",
  );
});

test("keys outside the pattern find nothing", () => {
  for (const key of [undefined, "", "..", ".", "a/b", "a\\b", "x".repeat(129)])
    expect(artifactPath(transcripts, key)).toBeNull();
  const single = PrivateArtifactSchema.parse({ name: "summary", mount: "harness-state", pattern: "summary.json" });
  expect(artifactPath(single, undefined)).toBe("summary.json");
  expect(artifactPath(single, "extra")).toBeNull();
});

test("patterns stay inside their mount", () => {
  for (const pattern of ["../secret", "/etc/passwd", "chats/*/*/x", "a//b", "chats/**/x", "./x"])
    expect(PrivateArtifactSchema.safeParse({ name: "bad", mount: "state", pattern }).success).toBe(false);
});
