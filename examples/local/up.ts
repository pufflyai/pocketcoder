import { resolve } from "node:path";
import { loadConfig } from "@pstdio/pocketcoder-server/config";
import { startPocketcoderServer } from "@pstdio/pocketcoder-server/lifecycle";
import { startOpenAIGateway } from "../harnesses/pi/openai-gateway";
import { requireOpenAIKey, resolveLocalPiOptions } from "./options";
import { preparePiRuntime } from "./runtime";

const options = resolveLocalPiOptions();
const apiKey = options.useOpenAI ? requireOpenAIKey(true) : null;
const prepared = await preparePiRuntime({
	root: options.root,
	gatewayUrl: options.gatewayUrl,
	gatewayModel: options.gatewayModel,
	gatewayProvider: options.gatewayProvider,
	gatewayApi: options.gatewayApi,
});

const gateway = apiKey
	? startOpenAIGateway({
			apiKey,
			clientBearer: prepared.bearer,
			organization: process.env.OPENAI_ORGANIZATION,
			project: process.env.OPENAI_PROJECT,
			port: options.gatewayPort,
		})
	: null;

const server = await startPocketcoderServer(
	loadConfig({
		...process.env,
		POCKETCODER_TEMPLATE_DIR: resolve(options.root, ".pocketcoder/local/templates"),
		POCKETCODER_SECRET_PROVIDER: "file",
		POCKETCODER_SECRET_ROOT: prepared.secretRoot,
	}),
);

console.log(
	`local runtime ready: ${prepared.templateName}@${prepared.templateVersion} (${prepared.templateDigest.slice(0, 19)}...)`,
);
console.log(`template: ${prepared.templatePath}`);
if (gateway) console.log(`model gateway: http://127.0.0.1:${gateway.port}`);
console.log(`PocketCoder API: ${server.url}`);
console.log("Use pcd templates list, pcd workspaces create --wait, and pcd workspaces chat.");

await new Promise<void>((resolveShutdown, rejectShutdown) => {
	let stopping = false;
	const shutdown = () => {
		if (stopping) return;
		stopping = true;
		gateway?.stop(true);
		server.stop().then(resolveShutdown, rejectShutdown);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
});
