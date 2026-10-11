import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { accountRepository } from "../database/account-repository";
import { managerContext } from "../database/context";
import { accountManifests } from "../kubernetes/manifests";
import { createRequestDigest } from "./intent";

test("the real account namespace carries an opaque, valid original CREATE request binding", async () => {
  const context = await managerContext();
  try {
    for (let index = 0; index < 32; index++) {
      const requestId = randomUUID();
      const { account } = await accountRepository(context).createAccount(
        requestId,
        { name: "private label" },
        {
          controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
          runtimeClassName: "pc-runc",
        },
        new Date(Date.now() + 60_000),
      );
      const namespace = accountManifests(account, ["10.0.0.1"]).find((resource) => resource.kind === "Namespace");
      const labels = namespace?.metadata.labels as Record<string, string>;
      const binding = labels["pocketcoder.dev/create-request"];
      expect(binding).toBe(`h${Buffer.from(createRequestDigest(requestId), "hex").toString("base64url")}h`);
      expect(binding).toMatch(/^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/);
      expect(JSON.stringify(labels)).not.toContain(requestId);
      expect(JSON.stringify(labels)).not.toContain(account.name);
    }
  } finally {
    await context.close();
  }
});
