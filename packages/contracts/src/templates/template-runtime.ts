import type { RuntimeTemplatePolicy } from "./template-schema";

export function templateServices(spec: RuntimeTemplatePolicy) {
  return spec.services ?? {};
}
