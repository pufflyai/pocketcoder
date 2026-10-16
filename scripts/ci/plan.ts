import { appendFile } from "node:fs/promises";
import { command } from "./command";
import { expectedJobs } from "./gate";
import { selectProjects, validationMode } from "./selection";
import { assertSuiteCoverage } from "./suite";

const event = process.env.GITHUB_EVENT_PATH ? await Bun.file(process.env.GITHUB_EVENT_PATH).json() : {};
const mode = validationMode(process.env.GITHUB_EVENT_NAME ?? "pull_request", process.env.CI_FULL === "true");
const all: string[] = JSON.parse(await command(["bun", "x", "nx", "show", "projects", "--json"], true));
const head = process.env.GITHUB_SHA ?? "HEAD";
const base = event.pull_request?.base.sha ?? event.before;
let selection = { projects: all.sort(), smoke: true };
if (mode === "fast" && base && !/^0+$/.test(base)) {
  const files = (await command(["git", "diff", "--name-only", `${base}...${head}`], true))
    .trim()
    .split("\n")
    .filter(Boolean);
  const affected: string[] = JSON.parse(
    await command(
      ["bun", "x", "nx", "show", "projects", "--affected", `--base=${base}`, `--head=${head}`, "--json"],
      true,
    ),
  );
  selection = selectProjects(files, affected, all);
}
const manifest = await Bun.file("package.json").json();
assertSuiteCoverage(manifest.scripts["test:all"]);
const postmerge = mode === "fast" && process.env.GITHUB_EVENT_NAME === "push";
const output = {
  mode,
  projects: JSON.stringify(selection.projects),
  hasProjects: String(selection.projects.length > 0),
  smoke: String(selection.smoke),
  postmerge: String(postmerge),
  required: JSON.stringify(expectedJobs(mode, selection.projects.length > 0, selection.smoke, postmerge)),
};
console.log(JSON.stringify(output, null, 2));
if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(output)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
