import { expect, test } from "bun:test";
import { parseTemplateManifest } from "../templates/template";
import { previewRequestHeaders, previewResponseHeaders } from "./headers";
import { PreviewsSchema, previewTarget } from "./preview";

const manifest = (previews: unknown) => ({
  apiVersion: "pocketcoder.dev/v1alpha1",
  kind: "Template",
  metadata: { name: "web" },
  spec: {
    version: "1.0.0",
    image: `test@sha256:${"a".repeat(64)}`,
    agent: { command: ["agent"] },
    resources: { cpu: "1", memory: "128Mi" },
    previews,
  },
});

test("previews declare bounded names and ports on native agent templates", () => {
  expect(parseTemplateManifest(manifest({ web: { port: 3000 } })).manifest.spec.previews).toEqual({
    web: { port: 3000 },
  });
  for (const name of ["display", "pc-api", "UPPER", "a".repeat(21)])
    expect(PreviewsSchema.safeParse({ [name]: { port: 3000 } }).success).toBe(false);
  for (const port of [80, 3284, 5900, 5901, 6080, 9222, 9229, 65536])
    expect(PreviewsSchema.safeParse({ web: { port } }).success).toBe(false);
});

test("preview destinations always stay on the declared loopback port", () => {
  expect(previewTarget(3000, "/assets?q=one&q=two").href).toBe("http://127.0.0.1:3000/assets?q=one&q=two");
  for (const path of ["http://evil.test/", "//evil.test/", "/\\evil.test/", "/\0bad"])
    expect(() => previewTarget(3000, path)).toThrow();
});

test("preview headers strip platform authority and unsafe redirect destinations", () => {
  expect(
    previewRequestHeaders(
      new Headers({
        authorization: "secret",
        cookie: "pc-preview-session=secret",
        "x-pocketcoder-registration": "secret",
        accept: "text/html",
      }),
    ),
  ).toEqual({ accept: "text/html" });
  expect(
    previewResponseHeaders(
      new Headers({
        location: "http://controller.test/",
        "set-cookie": "pc-preview-session=stolen",
        "content-type": "text/html",
        "x-frame-options": "DENY",
      }),
    ),
  ).toEqual({ "content-type": "text/html", "x-frame-options": "DENY" });
});
