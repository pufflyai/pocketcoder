import { ReleaseManifestSchema } from "@pstdio/pocketcoder-manager/upgrades";
import { controllerRelease } from "@pstdio/pocketcoder-server/release";

const [version, controllerImage, evidence, from, rollback] = process.argv.slice(2);
const manifest = ReleaseManifestSchema.parse({
  format: "pocketcoder-releases/v1",
  releases: [
    {
      ...controllerRelease,
      version,
      controllerImage,
      evidence,
      upgradesFrom: from?.split(",") ?? [],
      rollbackTo: rollback?.split(",") ?? [],
    },
  ],
});
console.log(JSON.stringify(manifest, null, 2));
