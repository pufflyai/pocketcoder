import { describe, expect, test } from "bun:test";
import { LOCAL_PI_PRINCIPAL_SCOPES, requireOpenAIKey, resolveLocalPiOptions } from "./options";

describe("local Pi operator options", () => {
  test("grants the local principal permission to upload attachments", () => {
    expect(LOCAL_PI_PRINCIPAL_SCOPES).toContain("attachments:write");
  });

  test("resolves explicit model and gateway settings without requiring a provider key", () => {
    const options = resolveLocalPiOptions({
      argv: ["bun", "prepare.ts", "--template", "pi-harness", "--openai"],
      env: {
        OPENAI_MODEL: "gpt-test",
        PI_GATEWAY_PORT: "8090",
      },
      root: "/operator/repo",
    });

    expect(options).toMatchObject({
      template: "pi-harness",
      useOpenAI: true,
      gatewayPort: 8090,
      gatewayUrl: "http://host.docker.internal:8090/v1",
      gatewayModel: "gpt-test",
      gatewayApi: "openai-responses",
    });
    expect(() => requireOpenAIKey(true, {})).toThrow("OPENAI_API_KEY");
  });
});
