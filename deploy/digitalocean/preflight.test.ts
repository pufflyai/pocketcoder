import { describe, expect, test } from "bun:test";
import { validateRenderedManifest } from "./preflight";
import { manifest, validDocuments } from "./preflight-fixtures";

interface DeploymentFixture {
  spec: { template: { spec: { containers: Array<{ image: string }> } } };
}

interface ConfigMapFixture {
  data: Record<string, string>;
}

interface PodFixture {
  spec: { containers: Array<{ image: string }> };
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

  test("requires the bootstrap admin Pod", () => {
    const documents = validDocuments().filter((document) => document.kind !== "Pod");
    expect(validateRenderedManifest(manifest(documents))).toContain("bootstrap admin image is required");
  });

  test("rejects a mutable bootstrap admin image", () => {
    const documents = validDocuments();
    const admin = documents.find((document) => document.kind === "Pod") as PodFixture;
    admin.spec.containers[0].image = "registry.example/server:latest";
    expect(validateRenderedManifest(manifest(documents))).toContain(
      "image registry.example/server:latest must use repo@sha256:<64 lowercase hex>",
    );
  });

  test("rejects a bootstrap admin image with a different valid digest", () => {
    const documents = validDocuments();
    const admin = documents.find((document) => document.kind === "Pod") as PodFixture;
    const server = documents[2] as DeploymentFixture;
    admin.spec.containers[0].image = server.spec.template.spec.containers[0].image.replace(
      "1234567890abcdef".repeat(4),
      "abcdef0123456789".repeat(4),
    );
    expect(validateRenderedManifest(manifest(documents))).toContain(
      "bootstrap admin image must match the server image",
    );
  });

  test("accepts a bootstrap admin image matching the server digest", () => {
    const documents = validDocuments();
    const admin = documents.find((document) => document.kind === "Pod") as PodFixture;
    const server = documents[2] as DeploymentFixture;
    expect(admin.spec.containers[0].image).toBe(server.spec.template.spec.containers[0].image);
    expect(validateRenderedManifest(manifest(documents))).toEqual([]);
  });

  test("rejects mutable and obvious placeholder image references", () => {
    const documents = validDocuments();
    const deployment = documents[2] as DeploymentFixture;
    deployment.spec.template.spec.containers[0].image = "registry.example/server:latest";
    const template = documents[3] as ConfigMapFixture;
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
    const service = documents[4] as ServiceFixture;
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
    const templates = documents[3] as ConfigMapFixture;
    templates.data["pi-harness.json"] = JSON.stringify({
      spec: {
        image: "registry.example/pocketcoder-pi:latest",
        agent: { env: { PI_GATEWAY_BEARER: "standing-token" } },
      },
    });
    const gateway = documents[6] as DeploymentFixture;
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
    const gateway = documents[6] as unknown as {
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
