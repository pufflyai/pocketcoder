import { resolve } from "node:path";

export interface LocalPiOptions {
	root: string;
	template: "pi-harness";
	useOpenAI: boolean;
	gatewayPort: number;
	gatewayUrl: string;
	gatewayModel: string;
	gatewayProvider: string;
	gatewayApi: "openai-completions" | "openai-responses";
}

interface ResolveLocalPiOptions {
	argv?: string[];
	env?: Record<string, string | undefined>;
	root?: string;
}

function flag(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

function positivePort(raw: string | undefined, fallback: number): number {
	const value = raw ? Number(raw) : fallback;
	if (!Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new Error("PI_GATEWAY_PORT must be an integer from 1 to 65535");
	}
	return value;
}

export function resolveLocalPiOptions(options: ResolveLocalPiOptions = {}): LocalPiOptions {
	const argv = options.argv ?? process.argv;
	const env = options.env ?? process.env;
	const template = flag(argv, "--template") ?? "pi-harness";
	if (template !== "pi-harness") {
		throw new Error("local Pi tooling currently supports only pi-harness");
	}

	const useOpenAI = argv.includes("--openai");
	const gatewayPort = positivePort(env.PI_GATEWAY_PORT, 8080);
	const gatewayModel = env.PI_GATEWAY_MODEL ?? env.OPENAI_MODEL;
	if (!gatewayModel) throw new Error("OPENAI_MODEL or PI_GATEWAY_MODEL is required");
	if (!useOpenAI && !env.PI_GATEWAY_URL) {
		throw new Error("set PI_GATEWAY_URL or use --openai");
	}

	return {
		root: resolve(options.root ?? resolve(import.meta.dir, "../..")),
		template,
		useOpenAI,
		gatewayPort,
		gatewayUrl: env.PI_GATEWAY_URL ?? `http://host.docker.internal:${gatewayPort}/v1`,
		gatewayModel,
		gatewayProvider:
			env.PI_GATEWAY_PROVIDER ?? (useOpenAI ? "pocketcoder-openai" : "pocketcoder-gateway"),
		gatewayApi:
			(env.PI_GATEWAY_API as "openai-completions" | "openai-responses" | undefined) ??
			(useOpenAI ? "openai-responses" : "openai-completions"),
	};
}

export function requireOpenAIKey(
	useOpenAI: boolean,
	env: Record<string, string | undefined> = process.env,
): string {
	if (!useOpenAI) throw new Error("the bundled host gateway currently requires --openai");
	const apiKey = env.OPENAI_API_KEY;
	if (!apiKey) throw new Error("OPENAI_API_KEY is required with --openai");
	return apiKey;
}
