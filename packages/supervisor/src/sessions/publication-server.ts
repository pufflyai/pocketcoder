import { randomBytes } from "node:crypto";
import type { SessionRun } from "./producer";
import { PublicationSelectionSchema } from "./publication";

export function publicationServer(run: SessionRun) {
  const publish = run.publishFile;
  if (!publish) return;
  const token = randomBytes(32).toString("base64url");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 16384,
    async fetch(request) {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/publish" ||
        request.headers.get("authorization") !== `Bearer ${token}`
      )
        return new Response("Forbidden", { status: 403 });
      try {
        run.signal.throwIfAborted();
        return Response.json(publish(PublicationSelectionSchema.parse(await request.json())));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "File publication failed" },
          { status: 409 },
        );
      }
    },
  });
  return {
    environment: {
      POCKETCODER_PUBLICATION_URL: `http://127.0.0.1:${server.port}/publish`,
      POCKETCODER_PUBLICATION_TOKEN: token,
    },
    stop: () => server.stop(true),
  };
}
