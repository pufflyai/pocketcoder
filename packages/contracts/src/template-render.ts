import { canonicalJson, sha256Hex } from "./canonical";
import { type ParsedTemplate, parseTemplateManifest } from "./template";

const PLACEHOLDER_IMAGE = /@sha256:0{64}$/;
const RELEASE_TRIPLET = /^\d+\.\d+\.\d+$/;

export interface TemplateRenderOptions {
  image?: string;
  set?: string[];
}

function segments(pointer: string): string[] {
  if (!pointer.startsWith("/") || pointer === "/") {
    throw new Error("override path must be a non-root JSON Pointer");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => {
      if (/~(?:[^01]|$)/.test(segment)) throw new Error(`invalid JSON Pointer: ${pointer}`);
      return segment.replaceAll("~1", "/").replaceAll("~0", "~");
    });
}

function record(value: unknown): Record<string, unknown> | unknown[] | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown> | unknown[])
    : null;
}

function setExisting(root: unknown, pointer: string, value: unknown): void {
  const path = segments(pointer);
  let target = record(root);
  for (const segment of path.slice(0, -1)) {
    if (!target || !Object.hasOwn(target, segment)) {
      throw new Error(`override path does not exist: ${pointer}`);
    }
    target = record(target[segment as keyof typeof target]);
  }
  const key = path.at(-1) as string;
  if (!target || !Object.hasOwn(target, key)) {
    throw new Error(`override path does not exist: ${pointer}`);
  }
  Reflect.set(target, key, value);
}

function override(raw: string) {
  const separator = raw.indexOf("=");
  if (separator < 1) throw new Error("--set must use <json-pointer>=<json-value>");
  const pointer = raw.slice(0, separator);
  try {
    return { pointer, value: JSON.parse(raw.slice(separator + 1)) as unknown };
  } catch {
    throw new Error(`override value for ${pointer} must be valid JSON`);
  }
}

function valueAt(root: unknown, pointer: string): unknown {
  let value = root;
  for (const segment of segments(pointer)) {
    const target = record(value);
    if (!target || !Object.hasOwn(target, segment)) return undefined;
    value = target[segment as keyof typeof target];
  }
  return value;
}

export function renderTemplateManifest(
  input: unknown,
  options: TemplateRenderOptions = {},
): ParsedTemplate {
  const rendered = structuredClone(input);
  if (options.image !== undefined) setExisting(rendered, "/spec/image", options.image);
  for (const raw of options.set ?? []) {
    const item = override(raw);
    setExisting(rendered, item.pointer, item.value);
  }

  const image = valueAt(rendered, "/spec/image");
  if (typeof image === "string" && PLACEHOLDER_IMAGE.test(image)) {
    throw new Error("--image is required while the template uses the placeholder digest");
  }
  const baseVersion = valueAt(rendered, "/spec/version");
  if (typeof baseVersion !== "string" || !RELEASE_TRIPLET.test(baseVersion)) {
    throw new Error("spec.version must be a release triplet like 1.2.3");
  }

  const normalized = parseTemplateManifest(rendered).manifest;
  const { version: _version, ...specWithoutVersion } = normalized.spec;
  const revision = sha256Hex(canonicalJson({ ...normalized, spec: specWithoutVersion })).slice(
    0,
    12,
  );
  return parseTemplateManifest({
    ...normalized,
    spec: { ...normalized.spec, version: `${baseVersion}-${revision}` },
  });
}
