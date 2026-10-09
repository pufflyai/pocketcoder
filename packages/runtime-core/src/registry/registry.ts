import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ParsedTemplate, parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import type { Store, TemplateRow } from "../types";

// Template registry: loads reviewed template files from a deployment
// directory, validates them, and upserts immutable versions. Changing content
// without changing the version is an error. Import is additive: retirement
// requires explicit operator authority and cannot be undone by a startup file.

export interface RegistryLoadResult {
  loaded: TemplateRow[];
  errors: Array<{ file: string; message: string }>;
}

export async function loadTemplateSource(path: string): Promise<unknown> {
  const text = await Bun.file(path).text();
  if (path.endsWith(".json")) {
    return JSON.parse(text);
  } else if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    const yaml = (Bun as unknown as { YAML?: { parse(t: string): unknown } }).YAML;
    if (!yaml) {
      throw new Error("this Bun build cannot parse YAML; use a .json template");
    }
    return yaml.parse(text);
  } else {
    throw new Error(`unsupported template file extension: ${path}`);
  }
}

export async function loadTemplateFile(path: string): Promise<ParsedTemplate> {
  return parseTemplateManifest(await loadTemplateSource(path));
}

export async function loadTemplateDir(store: Store, dir: string): Promise<RegistryLoadResult> {
  const result: RegistryLoadResult = { loaded: [], errors: [] };
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => /\.(json|ya?ml)$/.test(f)).sort();
  } catch (err) {
    result.errors.push({ file: dir, message: `cannot read template dir: ${String(err)}` });
    return result;
  }
  for (const file of files) {
    const path = join(dir, file);
    try {
      const parsed = await loadTemplateFile(path);
      const upsert = await store.upsertTemplate({
        name: parsed.manifest.metadata.name,
        version: parsed.manifest.spec.version,
        digest: parsed.digest,
        description: parsed.manifest.metadata.description ?? null,
        spec: parsed.manifest.spec,
      });
      if (upsert.conflict) {
        result.errors.push({
          file,
          message:
            `template ${parsed.manifest.metadata.name}@${parsed.manifest.spec.version} ` +
            `content changed under an existing version; bump spec.version`,
        });
        continue;
      }
      result.loaded.push(upsert.row);
    } catch (err) {
      result.errors.push({ file, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
