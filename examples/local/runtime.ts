import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, parseTemplateManifest } from "../../packages/contracts/src/index";

export interface LocalCommandResult {
	stdout: string;
	stderr: string;
}

export type LocalCommandRunner = (
	args: string[],
	options?: { cwd?: string; quiet?: boolean },
) => Promise<LocalCommandResult>;

export interface PreparePiRuntimeOptions {
	root?: string;
	sourceTemplate?: string;
	outputDir?: string;
	secretRoot?: string;
	imageTag?: string;
	gatewayUrl: string;
	gatewayModel: string;
	gatewayProvider?: string;
	gatewayApi?: "openai-completions" | "openai-responses";
	command?: LocalCommandRunner;
}

export interface PreparedPiRuntime {
	templatePath: string;
	templateName: string;
	templateVersion: string;
	templateDigest: string;
	image: string;
	secretRoot: string;
	bearerPath: string;
	bearer: string;
}

export interface BuildLocalImageOptions {
	root: string;
	imageTag: string;
	context: string;
	dockerfile?: string;
	command?: LocalCommandRunner;
}

export async function runLocalCommand(
	args: string[],
	options: { cwd?: string; quiet?: boolean } = {},
): Promise<LocalCommandResult> {
	const child = Bun.spawn(args, {
		cwd: options.cwd,
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`${args.join(" ")} failed (${exitCode}): ${stderr.trim().slice(0, 4000)}`);
	}
	if (!options.quiet && stdout.trim()) console.log(stdout.trim());
	return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function buildLocalImage(
	options: BuildLocalImageOptions,
): Promise<{ imageId: string; image: string }> {
	const command = options.command ?? runLocalCommand;
	const build = [
		"docker",
		"build",
		...(options.dockerfile ? ["--file", options.dockerfile] : []),
		"--tag",
		options.imageTag,
		options.context,
	];
	await command(build, { cwd: options.root });
	const imageId = (
		await command(["docker", "image", "inspect", options.imageTag, "--format", "{{.Id}}"], {
			cwd: options.root,
			quiet: true,
		})
	).stdout;
	if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
		throw new Error(`docker returned an invalid local image ID: ${imageId}`);
	}
	return { imageId, image: `${options.imageTag}@${imageId}` };
}

async function ensureBearer(path: string): Promise<string> {
	try {
		const existing = (await readFile(path, "utf8")).trim();
		if (existing) {
			await chmod(path, 0o444);
			return existing;
		}
	} catch {
		// Create it below.
	}
	const bearer = randomBytes(32).toString("base64url");
	await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
	// The containing secret root is 0700 on the host. The bind-mounted file is
	// read-only but world-readable inside the isolated workspace so its
	// non-root runtime uid can consume it.
	await writeFile(path, `${bearer}\n`, { mode: 0o444 });
	await chmod(path, 0o444);
	return bearer;
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, content);
	await rename(temporary, path);
}

export async function preparePiRuntime(
	options: PreparePiRuntimeOptions,
): Promise<PreparedPiRuntime> {
	const root = resolve(options.root ?? resolve(import.meta.dir, "../.."));
	const sourceTemplate = resolve(
		options.sourceTemplate ?? resolve(root, "examples/templates/pi-harness.json"),
	);
	const outputDir = resolve(options.outputDir ?? resolve(root, ".pocketcoder/local/templates"));
	const secretRoot = resolve(options.secretRoot ?? resolve(root, ".pocketcoder/local/secrets"));
	const imageTag = options.imageTag ?? "pocketcoder-pi:local";
	const command = options.command ?? runLocalCommand;

	const builtImage = await buildLocalImage({
		root,
		imageTag,
		context: ".",
		dockerfile: "examples/harnesses/pi/Dockerfile",
		command,
	});

	const source = JSON.parse(await readFile(sourceTemplate, "utf8")) as {
		metadata: { name: string };
		spec: {
			version: string;
			image: string;
			harness: { env?: Record<string, string> };
		};
	};
	const sourceVersion = source.spec.version;
	source.spec.image = builtImage.image;
	source.spec.harness.env = {
		...source.spec.harness.env,
		PI_GATEWAY_URL: options.gatewayUrl,
		PI_GATEWAY_MODEL: options.gatewayModel,
		PI_GATEWAY_PROVIDER: options.gatewayProvider ?? "pocketcoder-openai",
		PI_GATEWAY_API: options.gatewayApi ?? "openai-responses",
		PI_GATEWAY_BEARER_REF: "secretRef:pi-gateway/bearer",
	};
	const materializationDigest = createHash("sha256").update(canonicalJson(source)).digest("hex");
	source.spec.version = `${sourceVersion}-local.${materializationDigest.slice(0, 12)}`;
	const parsed = parseTemplateManifest(source);

	const bearerPath = resolve(secretRoot, "pi-gateway/bearer");
	const bearer = await ensureBearer(bearerPath);
	const templatePath = resolve(outputDir, "pi-harness.json");
	await writeAtomic(templatePath, `${JSON.stringify(parsed.manifest, null, 2)}\n`);

	return {
		templatePath,
		templateName: parsed.manifest.metadata.name,
		templateVersion: parsed.manifest.spec.version,
		templateDigest: parsed.digest,
		image: parsed.manifest.spec.image,
		secretRoot,
		bearerPath,
		bearer,
	};
}
