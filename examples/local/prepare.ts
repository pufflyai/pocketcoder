import { resolveLocalPiOptions } from "./options";
import { preparePiRuntime } from "./runtime";

const options = resolveLocalPiOptions();
const prepared = await preparePiRuntime({
  root: options.root,
  gatewayUrl: options.gatewayUrl,
  gatewayModel: options.gatewayModel,
  gatewayProvider: options.gatewayProvider,
  gatewayApi: options.gatewayApi,
});

console.log(
  `prepared ${prepared.templateName}@${prepared.templateVersion} (${prepared.templateDigest})`,
);
console.log(`image: ${prepared.image}`);
console.log(`template: ${prepared.templatePath}`);
console.log(`secret root: ${prepared.secretRoot}`);
