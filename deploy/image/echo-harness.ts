// Harmless echo harness serving AgentAPI's three conversation routes on
// loopback. Used by the fixture-echo template and doctor probes; real
// templates run AgentAPI wrapping a coding-agent CLI instead. Setting
// POCKETCODER_ECHO_STATE makes its conversation state checkpointable.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const statePath = process.env.POCKETCODER_ECHO_STATE;
const messages: Array<{ role: string; content: string }> =
  statePath && existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as Array<{
        role: string;
        content: string;
      }>)
    : [];
const status: "stable" | "running" = "stable";

function persist(): void {
  if (!statePath) return;
  mkdirSync(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(messages)}\n`, { mode: 0o600 });
  renameSync(temporary, statePath);
}

function emitConversation(role: "user" | "assistant", content: string): void {
  console.log(
    `POCKETCODER_CONVERSATION ${JSON.stringify({
      message_id: randomUUID(),
      role,
      content,
      occurred_at: new Date().toISOString(),
      metadata: { source: "echo-harness" },
    })}`,
  );
}

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.HARNESS_PORT ?? 3284),
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/status") {
      return Response.json({ status });
    }
    if (req.method === "GET" && url.pathname === "/messages") {
      return Response.json({ messages });
    }
    if (req.method === "POST" && url.pathname === "/message") {
      return req.json().then((body) => {
        const content = String((body as { content?: unknown }).content ?? "");
        messages.push({ role: "user", content });
        messages.push({ role: "agent", content: `echo: ${content}` });
        emitConversation("user", content);
        emitConversation("assistant", `echo: ${content}`);
        persist();
        return Response.json({ ok: true });
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log("echo-harness listening");
