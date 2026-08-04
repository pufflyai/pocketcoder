import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

const image = process.env.POCKETCODER_KUBERNETES_EGRESS_CONFORMANCE_IMAGE;
const conformanceTest = image ? test : test.skip;

async function kubectl(args: string[], input?: string, allowFailure = false) {
	const process = Bun.spawn(["kubectl", ...args], {
		stdin: input === undefined ? undefined : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (input !== undefined) {
		process.stdin.write(input);
		process.stdin.end();
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0 && !allowFailure) throw new Error(stderr.trim());
	return { stdout: stdout.trim(), exitCode };
}

conformanceTest(
	"supported Kubernetes runs the same restricted sidecar boundary",
	async () => {
		const namespace = `pc-egress-${randomUUID().slice(0, 8)}`;
		const auditHost = `audit.${namespace}.svc.cluster.local`;
		const config = JSON.stringify({
			policy: {
				mode: "restricted",
				allow: [{ domain: auditHost, ports: [8080], allowPrivate: true }],
			},
			control_url: `http://${auditHost}:8080`,
			audit_url: `http://${auditHost}:8080/events`,
			audit_token: "conformance",
		});
		const auditScript = [
			"Bun.serve({hostname:'0.0.0.0',port:8080,async fetch(r){",
			"const u=new URL(r.url);if(r.method==='POST'&&u.pathname==='/events'){",
			"const b=await r.json();for(const e of b.events)console.log('EVENT '+JSON.stringify(e));",
			"return Response.json({accepted:b.events.length})}",
			"return new Response(u.pathname==='/allowed'?'allowed':'not found',",
			"{status:u.pathname==='/allowed'?200:404})}})",
		].join("");
		const workloadScript = [
			"set -eu",
			"proxy=http://127.0.0.1:18080",
			`test "$(curl -fsS --proxy "$proxy" 'http://${auditHost}:8080/allowed?credential=redacted')" = allowed`,
			"test \"$(curl -sS -o /dev/null -w '%{http_code}' --proxy \"$proxy\" 'http://denied.invalid/private?credential=redacted')\" = 403",
			`if curl -fsS --noproxy '*' --connect-timeout 1 'http://${auditHost}:8080/allowed'; then exit 1; fi`,
		].join("\n");
		const objects = [
			{ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } },
			{
				apiVersion: "v1",
				kind: "Secret",
				metadata: { name: "egress", namespace },
				stringData: { "egress.json": config },
			},
			{
				apiVersion: "apps/v1",
				kind: "Deployment",
				metadata: { name: "audit", namespace },
				spec: {
					replicas: 1,
					selector: { matchLabels: { app: "audit" } },
					template: {
						metadata: { labels: { app: "audit" } },
						spec: {
							containers: [
								{
									name: "audit",
									image: "oven/bun:1.3.14-alpine",
									command: ["bun", "-e", auditScript],
									ports: [{ containerPort: 8080 }],
								},
							],
						},
					},
				},
			},
			{
				apiVersion: "v1",
				kind: "Service",
				metadata: { name: "audit", namespace },
				spec: { selector: { app: "audit" }, ports: [{ port: 8080, targetPort: 8080 }] },
			},
			{
				apiVersion: "batch/v1",
				kind: "Job",
				metadata: { name: "workspace", namespace },
				spec: {
					backoffLimit: 0,
					template: {
						spec: {
							restartPolicy: "Never",
							volumes: [{ name: "egress", secret: { secretName: "egress" } }],
							initContainers: [
								{
									name: "egress",
									image,
									restartPolicy: "Always",
									securityContext: {
										runAsUser: 0,
										allowPrivilegeEscalation: false,
										readOnlyRootFilesystem: true,
										capabilities: {
											drop: ["ALL"],
											add: ["NET_ADMIN", "SETUID", "SETGID"],
										},
									},
									startupProbe: {
										httpGet: { path: "/readyz", port: 18082 },
										periodSeconds: 1,
										failureThreshold: 30,
									},
									volumeMounts: [
										{
											name: "egress",
											mountPath: "/run/pocketcoder/egress.json",
											subPath: "egress.json",
											readOnly: true,
										},
									],
								},
							],
							containers: [
								{
									name: "workspace",
									image: "curlimages/curl:8.16.0",
									command: ["sh", "-c", workloadScript],
									securityContext: {
										runAsNonRoot: true,
										allowPrivilegeEscalation: false,
										readOnlyRootFilesystem: true,
										capabilities: { drop: ["ALL"] },
									},
								},
							],
						},
					},
				},
			},
		];

		try {
			await kubectl(
				["apply", "-f", "-"],
				objects.map((item) => JSON.stringify(item)).join("\n---\n"),
			);
			await kubectl(["rollout", "status", "deployment/audit", "-n", namespace, "--timeout=60s"]);
			await kubectl([
				"wait",
				"--for=condition=complete",
				"job/workspace",
				"-n",
				namespace,
				"--timeout=60s",
			]);
			await Bun.sleep(500);
			const logs = await kubectl(["logs", "deployment/audit", "-n", namespace]);
			expect(logs.stdout).toContain('"decision":"allow"');
			expect(logs.stdout).toContain('"path":"/allowed"');
			expect(logs.stdout).toContain('"decision":"deny"');
			expect(logs.stdout).not.toContain("credential=redacted");
		} finally {
			await kubectl(["delete", "namespace", namespace, "--wait=false"], undefined, true);
		}
	},
	90_000,
);
