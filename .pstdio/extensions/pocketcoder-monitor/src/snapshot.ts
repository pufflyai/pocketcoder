export interface PocketcoderWorkspace {
	id: string;
	external_id: string;
	state: string;
	reason_code: string | null;
	template: {
		name: string;
		version: string;
	};
	created_at?: string;
	updated_at?: string;
}

export interface PocketcoderTemplate {
	name: string;
	version: string;
	status: string;
	digest: string;
	description?: string;
}

export interface MonitorError {
	source: "workspaces" | "templates";
	message: string;
}

export interface PocketcoderSnapshot {
	refreshedAt: string;
	workspaces: PocketcoderWorkspace[];
	templates: PocketcoderTemplate[];
	errors: MonitorError[];
}

interface ProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface ProcessInput {
	command: string[];
	cwd?: string;
	timeoutMs?: number;
}

export interface ProcessRunner {
	run(input: ProcessInput): Promise<ProcessResult>;
}

interface LoadSnapshotInput {
	process: ProcessRunner;
	repoPath: string;
	now?: () => Date;
}

const query = async <T>(
	process: ProcessRunner,
	repoPath: string,
	source: MonitorError["source"],
	args: string[],
): Promise<{ items: T[]; error?: MonitorError }> => {
	try {
		const result = await process.run({
			command: ["bun", "run", "pcd", "--", ...args],
			cwd: repoPath,
			timeoutMs: 15_000,
		});
		if (result.exitCode !== 0) {
			return {
				items: [],
				error: {
					source,
					message:
						result.stderr.trim() ||
						result.stdout.trim() ||
						`Command exited with code ${result.exitCode}.`,
				},
			};
		}

		const value: unknown = JSON.parse(result.stdout);
		if (!Array.isArray(value)) {
			return {
				items: [],
				error: { source, message: "PocketCoder returned an unexpected response." },
			};
		}
		return { items: value as T[] };
	} catch (error) {
		return {
			items: [],
			error: {
				source,
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
};

export const loadPocketcoderSnapshot = async ({
	process,
	repoPath,
	now = () => new Date(),
}: LoadSnapshotInput): Promise<PocketcoderSnapshot> => {
	const [workspaces, templates] = await Promise.all([
		query<PocketcoderWorkspace>(process, repoPath, "workspaces", [
			"workspaces",
			"list",
			"--active",
			"--json",
		]),
		query<PocketcoderTemplate>(process, repoPath, "templates", ["templates", "list", "--json"]),
	]);

	return {
		refreshedAt: now().toISOString(),
		workspaces: workspaces.items,
		templates: templates.items,
		errors: [workspaces.error, templates.error].filter(
			(error): error is MonitorError => error !== undefined,
		),
	};
};
