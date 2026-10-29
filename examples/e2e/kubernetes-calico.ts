import { createHash } from "node:crypto";
import { command } from "./local-process";

const URL = "https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/calico.yaml";
const SHA256 = "2de8f47595fb9c41b3f47d7b767a1f8e72ecf84057af834738ff12689a234da5";
export async function installCalico(kube: (args: string[], input?: string) => Promise<string>) {
  const response = await fetch(URL);
  if (!response.ok) throw new Error("Pinned Calico manifest download failed");
  let yaml = await response.text();
  if (createHash("sha256").update(yaml).digest("hex") !== SHA256) throw new Error("Calico manifest checksum changed");
  for (const image of [
    "quay.io/calico/node:v3.33.0",
    "quay.io/calico/calico:v3.33.0",
    "quay.io/calico/third-party-cni-plugins:v3.33.0",
  ]) {
    const result = await command(
      ["docker", "buildx", "imagetools", "inspect", image, "--format", "{{.Manifest.Digest}}"],
      { quiet: true },
    );
    const digest = result.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Calico image digest unavailable");
    yaml = yaml.replaceAll(`image: ${image}`, `image: ${image.split(":")[0]}@${digest}`);
  }
  // Docker nodes use VXLAN rather than requiring the host's IP-in-IP module.
  yaml = yaml
    .replace(
      '# - name: CALICO_IPV4POOL_CIDR\n            #   value: "192.168.0.0/16"',
      '- name: CALICO_IPV4POOL_CIDR\n              value: "10.244.0.0/16"',
    )
    .replace(
      'name: CALICO_IPV4POOL_IPIP\n              value: "Always"',
      'name: CALICO_IPV4POOL_IPIP\n              value: "Never"',
    )
    .replace(
      'name: CALICO_IPV4POOL_VXLAN\n              value: "Never"',
      'name: CALICO_IPV4POOL_VXLAN\n              value: "Always"',
    );
  await kube(["create", "-f", "-"], yaml);
  await kube(["-n", "kube-system", "rollout", "status", "daemonset/calico-node", "--timeout=120s"]);
  await kube(["wait", "nodes", "--all", "--for=condition=Ready", "--timeout=120s"]);
}
