import type {
  AgentFrame,
  ExecSpec,
  ProxyRequest,
  TemplateService,
  TemplateServiceRoute,
} from "@pstdio/pocketcoder-contracts";

type SendFrame = (type: AgentFrame["type"], payload: unknown) => boolean;

export async function relayProxyRequest(
  request: ProxyRequest,
  callbacks: {
    exec(): ExecSpec | null;
    isQuiescing(): boolean;
    send: SendFrame;
    onAgentTurn(): void;
    probeAgent(exec: ExecSpec): void;
    relayStream(
      request: ProxyRequest,
      service: TemplateService,
      route: TemplateServiceRoute,
    ): Promise<void>;
  },
) {
  const exec = callbacks.exec();
  const service = exec?.services[request.service];
  const route = service?.routes.find(
    (candidate) => candidate.method === request.method && candidate.path === request.path,
  );
  if (!service || !route) {
    callbacks.send("proxy_response", {
      request_id: request.request_id,
      headers: {},
      error_code: "unreachable",
    });
    return;
  }
  if (route.responseMode === "stream") {
    await callbacks.relayStream(request, service, route);
    return;
  }
  const beginsAgentTurn =
    request.service === "agent" && request.method === "POST" && request.path === "/message";
  if (callbacks.isQuiescing() && beginsAgentTurn) {
    callbacks.send("proxy_response", {
      request_id: request.request_id,
      status: 409,
      headers: { "content-type": "application/json" },
      body_b64: Buffer.from(JSON.stringify({ error: "workspace is quiescing" })).toString("base64"),
    });
    return;
  }
  if (beginsAgentTurn) callbacks.onAgentTurn();
  const url = new URL(request.path, service.baseUrl);
  for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      ...(request.body_b64 ? { body: Buffer.from(request.body_b64, "base64") } : {}),
      signal: AbortSignal.timeout(request.deadline_ms),
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > route.maxResponseBytes) {
      callbacks.send("proxy_response", {
        request_id: request.request_id,
        headers: {},
        error_code: "too_large",
      });
      return;
    }
    callbacks.send("proxy_response", {
      request_id: request.request_id,
      status: response.status,
      headers: response.headers.get("content-type")
        ? { "content-type": response.headers.get("content-type") as string }
        : {},
      ...(body.byteLength > 0 ? { body_b64: body.toString("base64") } : {}),
    });
    if (beginsAgentTurn && exec) callbacks.probeAgent(exec);
  } catch (error) {
    callbacks.send("proxy_response", {
      request_id: request.request_id,
      headers: {},
      error_code:
        error instanceof Error && error.name === "TimeoutError" ? "deadline" : "unreachable",
    });
  }
}
