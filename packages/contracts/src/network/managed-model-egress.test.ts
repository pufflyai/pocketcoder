import { expect, test } from "bun:test";
import { managedModelEgressRefusal } from "./managed-model-egress";

const provider = ["api.openai.com"];

test("only restricted egress that cannot reach the provider qualifies for budgeted models", () => {
  expect(managedModelEgressRefusal({ mode: "unrestricted" }, provider)).toBe("network_unrestricted");
  expect(managedModelEgressRefusal({ mode: "restricted", allow: [] }, provider)).toBeNull();
  const rule = (domain: string) => ({ domain, ports: [443], allowPrivate: false });
  expect(managedModelEgressRefusal({ mode: "restricted", allow: [rule("tools.example.com")] }, provider)).toBeNull();
  for (const domain of ["api.openai.com", "*.openai.com"])
    expect(managedModelEgressRefusal({ mode: "restricted", allow: [rule(domain)] }, provider)).toBe(
      "provider_route_allowed",
    );
});
