import { join } from "node:path";
import type { RunRequest, RunResult } from "./protocol";
import { git } from "./source";

async function output(command: string[], cwd: string) {
  try {
    const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const [code, text] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timer);
    return code === 0 ? text.trim() : "";
  } catch {
    return "";
  }
}
export async function preflight(request: RunRequest, repo: string) {
  const checks: RunResult["preflight"] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ check: name, ok, ...(detail ? { detail } : {}) });
  check("workspace-deadline", Date.now() + (request.timeoutSeconds + 180) * 1000 <= Date.parse(request.deadlineAt));
  if (request.requires.includes("git-history"))
    check("git-history", Boolean(await git(repo, "merge-base", "origin/main", "HEAD").catch(() => "")));
  if (request.target)
    check("target-host", request.target.os === process.platform && request.target.arch === process.arch);
  const pkg = await Bun.file(join(repo, "package.json"))
    .json()
    .catch(() => ({}));
  const bun = Bun.version;
  const node = (await output(["node", "--version"], repo)).replace(/^v/, "");
  const playwright = process.env.POCKETCODER_PLAYWRIGHT_VERSION ?? "";
  const docker = request.requires.includes("docker")
    ? await output(["docker", "info", "--format", "{{.ServerVersion}}"], repo)
    : "";
  if (request.requires.includes("docker")) check("docker-daemon", Boolean(docker));
  if (pkg.packageManager?.startsWith("bun@")) check("bun-pin", pkg.packageManager === `bun@${bun}`);
  const workflow = await Bun.file(join(repo, ".github/workflows/test-and-build.yml"))
    .text()
    .catch(() => "");
  const nodePins = [...workflow.matchAll(/node-version:\s*["']?(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  if (nodePins.length)
    check(
      "node-pin",
      nodePins.every((pin) => pin === node),
    );
  if (request.requires.includes("browsers")) {
    const e2e = await Bun.file(join(repo, "packages/e2e/package.json"))
      .json()
      .catch(() => ({}));
    const pin =
      pkg.devDependencies?.playwright ??
      pkg.dependencies?.playwright ??
      e2e.devDependencies?.playwright ??
      e2e.dependencies?.playwright;
    check("playwright-pin", Boolean(pin) && pin === playwright);
    const script =
      'const {chromium}=require("/opt/pocketcoder/browser/node_modules/playwright"); chromium.launch({headless:true,args:["--no-sandbox"]}).then(async b=>{await b.close(); console.log("ok")}).catch(()=>process.exit(1))';
    check("playwright-chromium", (await output(["node", "-e", script], repo)) === "ok");
  }
  return {
    checks,
    runtime: {
      ...request.runtime,
      image: process.env.POCKETCODER_RUNTIME_IMAGE ?? request.runtime.image,
      placement: process.env.POCKETCODER_RUNTIME_PLACEMENT ?? request.runtime.placement,
      bun,
      node,
      playwright,
      docker,
    },
  };
}
