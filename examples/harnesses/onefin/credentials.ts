export interface OnefinInput {
  onefin_api_url: string;
  bootstrap_code: string;
  task_id: string;
}
interface Claims {
  exp: number;
  jti: string;
  task_id: string;
}
const claims = (token: string) => JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Claims;

export async function onefinCredentials(input: OnefinInput) {
  const apiUrl = input.onefin_api_url.replace(/\/$/, "");
  async function post(path: string, body: unknown, bearer?: string) {
    const response = await fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Onefin credential request failed (${response.status})`);
    return response.status === 204
      ? null
      : (response.json() as Promise<{ access_token: string; conversation_context?: unknown }>);
  }
  const session = await post("/api/auth/agent_session/bootstrap/", { code: input.bootstrap_code });
  if (!session?.access_token) throw new Error("Onefin bootstrap returned no credential");
  let token = session.access_token;
  if (claims(token).task_id !== input.task_id) {
    await post("/api/auth/agent_session/revoke/", { jti: claims(token).jti }, token);
    throw new Error("Onefin bootstrap belongs to another task");
  }
  let rotation: Promise<void> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    apiUrl,
    context: session.conversation_context,
    async accessToken() {
      if (closed) throw new Error("Onefin credential session is closed");
      if (claims(token).exp <= Date.now() / 1000 + 60) {
        rotation ??= post("/api/auth/agent_session/", {}, token)
          .then((session) => {
            if (!session?.access_token) throw new Error("Onefin refresh returned no credential");
            token = session.access_token;
          })
          .finally(() => {
            rotation = undefined;
          });
        await rotation;
      }
      if (closed) throw new Error("Onefin credential session is closed");
      return token;
    },
    async revoke() {
      closed = true;
      closing ??= (async () => {
        await rotation?.catch(() => {});
        await post("/api/auth/agent_session/revoke/", { jti: claims(token).jti }, token);
      })();
      try {
        await closing;
      } catch (error) {
        closing = undefined;
        throw error;
      }
    },
  };
}
