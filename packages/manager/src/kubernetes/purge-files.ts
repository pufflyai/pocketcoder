import { lookup } from "node:dns/promises";
import type { ManagerPurgeConfig } from "../purge/config";
import { createRequestDigest } from "../purge/intent";

export const purgeSecret = "controller-purge";
export const purgeFileMount = { name: "purge-config", mountPath: "/purge-config", readOnly: true };
export const purgeSecretVolume = { name: "purge-config", secret: { secretName: purgeSecret, defaultMode: 0o400 } };
export const installPurgeFiles =
  "await f.mkdir('/private/purge',{recursive:true,mode:0o700});await f.chown('/private/purge',0,0);await f.chmod('/private/purge',0o700);const t='/private/purge/.config.json.tmp';await f.rm(t,{force:true});await f.copyFile('/purge-config/config.json',t);await f.chmod(t,0o600);await f.chown(t,10001,10001);await f.rename(t,'/private/purge/config.json');await f.chown('/private/purge',10001,10001)";

export function purgeControllerFiles(config: ManagerPurgeConfig) {
  return {
    async destinations() {
      const endpoint = new URL(config.storage.endpoint);
      const addresses = await lookup(endpoint.hostname, { all: true });
      if (!addresses.length) throw new Error("Purge authority destinations are missing.");
      const port = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
      return addresses.map(({ address, family }) => ({ cidr: `${address}/${family === 6 ? 128 : 32}`, port }));
    },
    accountFiles(accountId: string, requestId: string) {
      return {
        "config.json": Buffer.from(
          JSON.stringify({ accountId, createRequestDigest: createRequestDigest(requestId), storage: config.storage }),
        ).toString("base64"),
      };
    },
  };
}
export type PurgeControllerFiles = ReturnType<typeof purgeControllerFiles>;
