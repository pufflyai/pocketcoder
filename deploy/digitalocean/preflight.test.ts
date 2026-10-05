import { describe, expect, test } from "bun:test";
import { validateRenderedManifest } from "./preflight";
import { manifest, validDocuments } from "./preflight-fixtures";

interface DeploymentFixture {
  spec: { template: { spec: { containers: Array<{ image: string }> } } };
}

interface ConfigMapFixture {
  data: Record<string, string>;
}

interface ServiceFixture {
  metadata: { name: string; annotations?: Record<string, string> };
  spec: Record<string, unknown>;
}

describe("DigitalOcean manifest preflight", () => {
  test("requires a separate block volume for controller data", () => {
    const documents = validDocuments();
    const claim = documents.at(-1) as { spec: { accessModes: string[]; storageClassName: string } };
    claim.spec.accessModes = ["ReadWriteMany"];
    claim.spec.storageClassName = "nfs";
    expect(validateRenderedManifest(manifest(documents))).toContain(
      "pocketcoder-data must use a block volume with ReadWriteOnce",
    );
  });
  test("accepts the private, digest-pinned deployment contract", () => {
    expect(validateRenderedManifest(manifest(validDocuments()))).toEqual([]);
  });

  test("rejects mutable and obvious placeholder image references", () => {
    const documents = validDocuments();
    const deployment = documents[4] as DeploymentFixture;
    deployment.spec.template.spec.containers[0].image = "registry.example/server:latest";
    const template = documents[5] as ConfigMapFixture;
    template.data["persistent-echo.json"] = JSON.stringify({
      spec: { image: `registry.example/workspace@sha256:${"a".repeat(64)}` },
    });

    expect(validateRenderedManifest(manifest(documents))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("registry.example/server:latest"),
        expect.stringContaining("placeholder digest"),
      ]),
    );
  });

  test("requires certificate configuration and narrow source ranges for public access", () => {
    const documents = validDocuments();
    const service = documents[6] as ServiceFixture;
    service.spec = { type: "LoadBalancer", loadBalancerSourceRanges: ["0.0.0.0/0"] };
    service.metadata.annotations = {
      "service.beta.kubernetes.io/do-loadbalancer-protocol": "https",
      "service.beta.kubernetes.io/do-loadbalancer-certificate-name": "REPLACE_CERTIFICATE",
    };

    expect(validateRenderedManifest(manifest(documents))).toEqual(
      expect.arrayContaining([expect.stringContaining("certificate"), expect.stringContaining("allow-all")]),
    );
  });

  test("requires a digest-pinned Pi image and a hardened session gateway", () => {
    const documents = validDocuments();
    const templates = documents[5] as ConfigMapFixture;
    templates.data["pi-harness.json"] = JSON.stringify({
      spec: {
        image: "registry.example/pocketcoder-pi:latest",
        agent: { env: { PI_GATEWAY_BEARER: "standing-token" } },
      },
    });
    const gateway = documents[8] as DeploymentFixture;
    gateway.spec.template.spec.containers[0].image = "registry.example/gateway:latest";
    const podSpec = gateway.spec.template.spec as unknown as Record<string, unknown>;
    podSpec.automountServiceAccountToken = true;

    expect(validateRenderedManifest(manifest(documents))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pocketcoder-pi:latest"),
        expect.stringContaining("gateway:latest"),
        expect.stringContaining("gateway must disable its service account token"),
        expect.stringContaining("projected session bearer"),
      ]),
    );
  });

  test("requires Pi and the gateway to use the same allowed model", () => {
    const documents = validDocuments();
    const gateway = documents[8] as unknown as {
      spec: {
        template: {
          spec: { containers: Array<{ env: Array<Record<string, unknown>> }> };
        };
      };
    };
    const model = gateway.spec.template.spec.containers[0]?.env.find(
      (entry) => entry.name === "PI_GATEWAY_ALLOWED_MODEL",
    );
    if (model) model.value = "different-model";

    expect(validateRenderedManifest(manifest(documents))).toContain("Pi and gateway must use the same allowed model");
  });
});
