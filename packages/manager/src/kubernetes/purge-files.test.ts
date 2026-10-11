import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { accountRepository } from "../database/account-repository";
import { managerContext } from "../database/context";
import { accountManifests } from "./manifests";

test("managed controllers without backups mount private purge authority outside account archives", async () => {
  const context = await managerContext();
  try {
    const { account } = await accountRepository(context).createAccount(
      randomUUID(),
      { name: "purge only" },
      {
        controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
        runtimeClassName: "pc-runc",
        purgeAuthority: true,
      },
      new Date(Date.now() + 60_000),
    );
    const resources = accountManifests(account, ["10.0.0.1"], [{ cidr: "192.0.2.1/32", port: 443 }]);
    const deployment = resources.find((resource) => resource.kind === "Deployment");
    if (!deployment || !("spec" in deployment)) throw new Error("Controller deployment is missing.");
    const pod = deployment.spec as {
      template: {
        spec: {
          volumes: unknown[];
          initContainers: { command: string[]; volumeMounts: unknown[] }[];
          containers: { env: { name: string; value: string }[]; volumeMounts: unknown[] }[];
        };
      };
    };
    expect(pod.template.spec.volumes).toContainEqual({
      name: "purge-config",
      secret: { secretName: "controller-purge", defaultMode: 0o400 },
    });
    expect(pod.template.spec.containers[0]?.env).toContainEqual({
      name: "POCKETCODER_PURGE_CONFIG",
      value: "/private/purge/config.json",
    });
    expect(pod.template.spec.initContainers[0]?.command.join(" ")).toContain("/private/purge");
    expect(pod.template.spec.initContainers[0]?.command.join(" ")).not.toContain("/private/pc_data/config");
    expect(JSON.stringify(pod.template.spec.containers[0]?.volumeMounts)).not.toContain("purge-config");
  } finally {
    await context.close();
  }
});
