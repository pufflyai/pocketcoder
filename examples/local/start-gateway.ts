import { randomBytes } from "node:crypto";
import { startOpenAIGateway } from "../harnesses/pi/openai-gateway";
import { startLeaseGateway } from "./lease-gateway";
import { type LocalPiOptions, requireOpenAIKey } from "./options";

export async function startLocalPiGateway(options: LocalPiOptions) {
  const bearer = randomBytes(32).toString("base64url");
  const upstream = options.useOpenAI
    ? startOpenAIGateway({
        apiKey: requireOpenAIKey(true),
        clientBearer: bearer,
        allowedModel: options.gatewayModel,
        organization: process.env.OPENAI_ORGANIZATION,
        project: process.env.OPENAI_PROJECT,
      })
    : null;
  const gateway = await startLeaseGateway({
    upstreamUrl: upstream ? `http://127.0.0.1:${upstream.port}` : options.gatewayUrl,
    upstreamBearer: upstream ? bearer : process.env.PI_GATEWAY_BEARER,
    port: options.gatewayPort,
  });
  return {
    ...gateway,
    async close() {
      await gateway.close();
      await upstream?.stop(true);
    },
  };
}
