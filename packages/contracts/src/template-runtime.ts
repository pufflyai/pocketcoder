import {
	type Agent,
	type Harness,
	ServiceSchema,
	type TemplateService,
	type TemplateSpec,
} from "./template-schema";

const AGENTAPI_SERVICE: TemplateService = ServiceSchema.parse({
	baseUrl: "http://127.0.0.1:3284",
	routes: [
		{ method: "GET", path: "/status" },
		{ method: "GET", path: "/messages", query: ["after"] },
		{ method: "POST", path: "/message" },
	],
});

export function isAgentApiNative(
	spec: TemplateSpec,
): spec is Extract<TemplateSpec, { agent: Agent }> {
	return "agent" in spec && spec.agent !== undefined;
}

export function agentApiHarness(spec: TemplateSpec): Harness {
	if (!isAgentApiNative(spec)) return spec.harness;
	return {
		command: [
			"/usr/local/bin/agentapi",
			"server",
			"--type",
			spec.agent.type,
			"--port",
			"3284",
			"--",
			...spec.agent.command,
		],
		env: spec.agent.env,
		...(spec.agent.cwd ? { cwd: spec.agent.cwd } : {}),
	};
}

export function templateServices(spec: TemplateSpec): Record<string, TemplateService> {
	return isAgentApiNative(spec) ? { agent: AGENTAPI_SERVICE } : spec.services;
}
