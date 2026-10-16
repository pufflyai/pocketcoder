import { appendFile } from "node:fs/promises";
import { command } from "./command";

type ValidationRun = {
  conclusion: string | null;
  event: string;
  head_branch: string;
  head_sha: string;
  head_repository: { full_name: string };
};

export function validatedRun(run: ValidationRun, repository: string, branch: string) {
  if (
    run.conclusion !== "success" ||
    run.event !== "push" ||
    run.head_branch !== branch ||
    run.head_repository.full_name !== repository ||
    !/^[a-f0-9]{40}$/.test(run.head_sha)
  )
    throw new Error("Publishing requires successful CI on the protected repository and branch");
  return run.head_sha;
}

export function publicationPolicy(current: string, sha: string, versionTag: boolean) {
  return { publish: versionTag || current === sha, latest: current === sha };
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const branch = process.env.CI_PUBLISH_BRANCH ?? "main";
  const event = await Bun.file(process.env.GITHUB_EVENT_PATH ?? "").json();
  const headers = { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" };
  async function github<T>(path: string) {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, { headers });
    if (!response.ok) throw new Error(`Cannot verify publication revision: HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }
  let run = event.workflow_run;
  if (!run) {
    const body = await github<{ workflow_runs: ValidationRun[] }>(
      `actions/workflows/ci.yml/runs?event=push&status=success&head_sha=${process.env.GITHUB_SHA}`,
    );
    run = body.workflow_runs.find((candidate: ValidationRun) => candidate.head_branch === branch);
  }
  if (!run) throw new Error("No successful CI run exists for this revision");
  const sha = validatedRun(run, repository, branch);
  const head = (await command(["git", "rev-parse", "HEAD"], true)).trim();
  if (head !== sha) throw new Error("Publication checkout differs from its successful CI revision");
  const current = await github<{ commit: { sha: string } }>(`branches/${encodeURIComponent(branch)}`);
  const versionTag = process.env.GITHUB_EVENT_NAME === "push" && /^refs\/tags\/v/.test(process.env.GITHUB_REF ?? "");
  if (versionTag) await command(["git", "merge-base", "--is-ancestor", sha, `origin/${branch}`]);
  const policy = publicationPolicy(current.commit.sha, sha, versionTag);
  if (!policy.publish) console.log("A newer protected-branch revision exists; this publication is superseded.");
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `sha=${sha}\npublish=${policy.publish}\nlatest=${policy.latest}\n`);
}
