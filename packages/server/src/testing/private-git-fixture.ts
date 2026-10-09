import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function git(args: string[]) {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw new Error(`Git fixture failed: ${error}`);
  return output.trim();
}

export async function privateGitFixture(host = "127.0.0.1") {
  const directory = await mkdtemp(join(tmpdir(), "pc-private-git-"));
  const worktree = join(directory, "source");
  await git(["init", "-q", "-b", "main", worktree]);
  await writeFile(join(worktree, "README.md"), "private fixture content\n");
  await git(["-C", worktree, "add", "README.md"]);
  await git([
    "-C",
    worktree,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-qm",
    "fixture",
  ]);
  const commit = await git(["-C", worktree, "rev-parse", "HEAD"]);
  await git(["clone", "-q", "--bare", worktree, join(directory, "app.git")]);
  let authorize = (_request: Request) => false;
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      if (!authorize(request)) return new Response("private source", { status: 401 });
      const url = new URL(request.url);
      const proc = Bun.spawn(["git", "http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: directory,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          REQUEST_METHOD: request.method,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          CONTENT_LENGTH: request.headers.get("content-length") ?? "",
          REMOTE_USER: "workspace",
        },
        stdin: request.body ?? "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const bytes = Buffer.from(await new Response(proc.stdout).arrayBuffer());
      if (await proc.exited) return new Response("Git backend failed", { status: 500 });
      const boundary = bytes.indexOf("\r\n\r\n");
      const headers = new Headers();
      let status = 200;
      for (const line of bytes.subarray(0, boundary).toString().split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.slice(0, 3));
        else headers.append(name, value);
      }
      return new Response(bytes.subarray(boundary + 4), { status, headers });
    },
  });
  return {
    url: `http://${host}:${server.port}/app.git`,
    commit,
    authorize(check: typeof authorize) {
      authorize = check;
    },
    async probe(credential: string) {
      return (
        await fetch(`http://127.0.0.1:${server.port}/app.git/info/refs?service=git-upload-pack`, {
          headers: { authorization: `Bearer ${credential}` },
        })
      ).status;
    },
    async close() {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export const PRIVATE_SOURCE_SETUP = `
const source = JSON.parse(process.env.POCKETCODER_SOURCE);
const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: Bearer " + source.credential };
const git = Bun.spawn(["git", "clone", "--branch", source.revision, source.url, source.destination], { env, stdout: "inherit", stderr: "inherit" });
if (await git.exited) process.exit(1);
await Bun.write(source.destination + "/captured-token", source.credential);
`;

export const PRIVATE_SOURCE_HARNESS = `
const captured = await Bun.file("/worktree/captured-token").text();
const source = JSON.parse(process.env.POCKETCODER_SOURCE);
const response = await fetch(source.url + "/info/refs?service=git-upload-pack", { headers: { authorization: "Bearer " + captured } });
if (response.status !== 401 || source.credential !== null) process.exit(1);
Bun.serve({ hostname: "127.0.0.1", port: 8080, async fetch(request) {
  if (new URL(request.url).pathname === "/status") return Response.json({ status: "stable" });
  return Response.json({ content: await Bun.file("/worktree/README.md").text(), credential_revoked: true });
} });
`;
