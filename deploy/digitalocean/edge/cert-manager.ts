import { createHash } from "node:crypto";

const RELEASE = "https://github.com/cert-manager/cert-manager/releases/download/v1.21.2/cert-manager.yaml";
const SHA256 = "e03b668ec8675214af6b0a671699d088f2601fa3878e0dbe1b41d3feafd1879f";
const IMAGES = {
  "quay.io/jetstack/cert-manager-controller:v1.21.2":
    "sha256:70f532fd9cfde0b09d55687200942399d89838bc2d5d5b45152eb799a15912b8",
  "quay.io/jetstack/cert-manager-cainjector:v1.21.2":
    "sha256:c85268c64f2e0e76684bf5fe8906caff34b82523561c6affe0fae3546bd87562",
  "quay.io/jetstack/cert-manager-webhook:v1.21.2":
    "sha256:a60e2dac46dbb8a7f3df95c54ce941012f54c2fe022f0ee55aaa1ab40ed957ae",
  "quay.io/jetstack/cert-manager-acmesolver:v1.21.2":
    "sha256:699b40d622211ab7accad8a21b04c5fbaa1841ef7a12621e8de492dbe27b2503",
};

// Renders the reviewed release with image digests so a later apply cannot change its code.
export async function certManagerManifest() {
  const response = await fetch(RELEASE);
  if (!response.ok) throw new Error("Pinned cert-manager manifest download failed");
  let yaml = await response.text();
  if (createHash("sha256").update(yaml).digest("hex") !== SHA256)
    throw new Error("cert-manager manifest checksum changed");
  for (const [image, digest] of Object.entries(IMAGES)) {
    if (!yaml.includes(image)) throw new Error(`cert-manager image ${image} is missing`);
    yaml = yaml.replaceAll(image, `${image.split(":")[0]}@${digest}`);
  }
  return yaml;
}

if (import.meta.main) process.stdout.write(await certManagerManifest());
