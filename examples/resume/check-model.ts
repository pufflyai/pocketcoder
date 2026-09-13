interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

function text(message: Message) {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
}

export function startCheckModel() {
  const prompts: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string; messages: Message[] };
      const user = body.messages.findLast((message) => message.role === "user");
      const last = body.messages.at(-1);
      if (!user || !last) throw new Error("Check model requires a user message");
      const prompt = text(user).trim();
      let delta: Record<string, unknown>;
      let finishReason = "stop";
      if (last.role === "tool") {
        delta = {
          role: "assistant",
          content: prompt.startsWith("Save token ") ? "Saved." : text(last),
        };
      } else if (prompt === "Recall the original token from our conversation.") {
        const original = body.messages.find(
          (message) => message.role === "user" && text(message).startsWith("Save token "),
        );
        delta = {
          role: "assistant",
          content: original ? text(original).slice("Save token ".length) : "No remembered token.",
        };
        prompts.push(prompt);
      } else {
        prompts.push(prompt);
        const save = prompt.startsWith("Save token ");
        delta = {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${crypto.randomUUID()}`,
              type: "function",
              function: {
                name: save ? "write" : "read",
                arguments: JSON.stringify(
                  save
                    ? {
                        path: "/workspace/resume-test.txt",
                        content: prompt.slice("Save token ".length),
                      }
                    : { path: "/workspace/resume-test.txt" },
                ),
              },
            },
          ],
        };
        finishReason = "tool_calls";
      }
      const chunk = (value: Record<string, unknown>, finish: string | null) => ({
        id: "check",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: value, finish_reason: finish }],
      });
      return new Response(
        "data: " +
          JSON.stringify(chunk(delta, null)) +
          "\n\n" +
          "data: " +
          JSON.stringify(chunk({}, finishReason)) +
          "\n\ndata: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, prompts, close: () => server.stop(true) };
}
