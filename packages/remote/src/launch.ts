import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PiInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
  resolvePath?: (specifier: string) => string;
}

const PI_FLAGS = [
  "--provider",
  "pocketcoder-agentapi",
  "--model",
  "remote-agent",
  "--api-key",
  "local-ui",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-context-files",
  "--no-prompt-templates",
  "--no-session",
  "--offline",
];

function piBinPath(resolvePath: (specifier: string) => string): string {
  // The package's exports map hides ./package.json, so locate the package
  // root from its resolved main entry instead.
  const entry = resolvePath("@earendil-works/pi-coding-agent");
  const marker = `${sep}pi-coding-agent${sep}`;
  const index = entry.lastIndexOf(marker);
  if (index === -1) {
    throw new Error(`could not locate @earendil-works/pi-coding-agent from ${entry}`);
  }
  const packageRoot = entry.slice(0, index + marker.length - 1);
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
  const bin = manifest.bin?.pi;
  if (!bin) throw new Error("@earendil-works/pi-coding-agent does not declare a pi bin");
  return resolve(packageRoot, bin);
}

export function extensionPath(moduleDir: string): string {
  // The extension sits beside the launcher in both layouts: pi loads the
  // TypeScript entry through jiti in dev, and the published tarball ships only
  // the bundle, which inlines the workspace-only packages it depends on.
  return resolve(moduleDir, moduleDir.endsWith(`${sep}src`) ? "extension.ts" : "extension.js");
}

export function resolvePiInvocation(options: ResolveOptions = {}): PiInvocation {
  const env = options.env ?? process.env;
  if (!env.POCKETCODER_KEY) {
    throw new Error(
      "POCKETCODER_KEY is required. Issue a machine key with `pcd keys issue` and export it, along with POCKETCODER_URL for your PocketCoder server.",
    );
  }
  // The pi package's exports map only defines the "import" condition, so
  // resolution must go through ESM resolve, not createRequire.
  const resolvePath =
    options.resolvePath ?? ((specifier: string) => fileURLToPath(import.meta.resolve(specifier)));
  const childEnv: NodeJS.ProcessEnv = { ...env };
  // Pi must never talk to a model provider directly; every turn goes
  // through the PocketCoder relay.
  delete childEnv.OPENAI_API_KEY;
  return {
    command: options.execPath ?? process.execPath,
    args: [
      piBinPath(resolvePath),
      ...PI_FLAGS,
      "--extension",
      extensionPath(dirname(fileURLToPath(import.meta.url))),
      ...(options.argv ?? []),
    ],
    env: childEnv,
  };
}
