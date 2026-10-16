const documentation =
  /^(docs\/|\.changeset\/.*\.md$|AGENTS\.md$|CLAUDE\.md$|README\.md$|LICENSE$|\.github\/pull_request_template\.md$)/;
const workspaceFile = /^(packages\/[^/]+\/|examples\/harnesses\/[^/]+\/)/;
const runtimeProject = /pocketcoder-(db|drivers|egress|runtime-core|server|supervisor|cli)$/;

export function validationMode(event: string, full: boolean) {
  if (event === "merge_group" || event === "schedule" || full) return "full";
  return "fast";
}

export function selectProjects(files: string[], affected: string[], all: string[]) {
  const code = files.filter((path) => !documentation.test(path));
  if (code.length === 0) return { projects: [], smoke: false };
  const broad = code.some((path) => !workspaceFile.test(path)) || affected.length === 0;
  const projects = [...new Set(broad ? all : affected)].sort();
  return { projects, smoke: projects.some((project) => runtimeProject.test(project)) };
}
