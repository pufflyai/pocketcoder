import { expect, test } from "bun:test";
import type { WorkspaceLaunch } from "@pstdio/pocketcoder-runtime-core";
import { appendWorkspaceMounts } from "./docker-args";

test("renders disposable persistence with its full byte budget and private ownership", () => {
  const args: string[] = [];
  appendWorkspaceMounts(args, {
    mounts: [
      { name: "work", target: "/work", source: { kind: "tmpfs", maxBytes: 5 * 1024 ** 3, uid: 12345, gid: 23456 } },
    ],
    secrets: [],
  } as unknown as WorkspaceLaunch);
  expect(args).toEqual(["--tmpfs", "/work:rw,noexec,nosuid,nodev,size=5368709120,uid=12345,gid=23456,mode=0700"]);
});
