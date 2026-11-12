import { SecuritySchema, ServiceSchema, TimeoutsSchema } from "./template-alpha-schema";
import { WorkloadTemplateSchema } from "./workload-template";

// Both echo and Pi implement the same controller-owned request protocol.
export function sessionTemplate(input: {
  name: string;
  version: string;
  image: string;
  runtimeDigest: string;
  producer: { digest: string; command: string[]; cwd?: string; env?: Record<string, string> };
}) {
  const protocol = "pocketcoder.execution/v1";
  const { producer } = input;
  return WorkloadTemplateSchema.parse({
    apiVersion: "pocketcoder.dev/v1",
    kind: "Template",
    metadata: { name: input.name },
    spec: {
      version: input.version,
      image: input.image,
      profile: "service",
      runtime: { protocol: "pocketcoder.workload/v1", digest: input.runtimeDigest },
      adapters: { session: { kind: "service", digest: producer.digest, protocol, service: "session", env: {} } },
      operations: {
        message: {
          adapter: "session",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
          requiredCapabilities: ["request-lookup", "deduplicated-accept", "targeted-cancel"],
          outputRoots: [],
        },
      },
      services: {
        session: {
          ...ServiceSchema.parse({
            baseUrl: "http://127.0.0.1:3284",
            healthPath: "/healthz",
            routes: ["accept", "lookup", "cancel", "ack"].map((action) => ({
              method: "POST",
              path: `/executions/${action}`,
              maxRequestBytes: 2 * 1024 * 1024,
              maxResponseBytes: 8 * 1024 * 1024,
              deadlineSeconds: 30,
            })),
          }),
          process: {
            command: producer.command,
            env: producer.env ?? {},
            ...(producer.cwd ? { cwd: producer.cwd } : {}),
          },
        },
      },
      previews: {},
      credentialSlots: {},
      resources: { cpu: "1", memory: "1Gi" },
      network: { mode: "unrestricted" },
      security: SecuritySchema.parse({ writableMemoryPaths: ["/tmp"] }),
      lifecycle: { timeouts: TimeoutsSchema.parse({}) },
      limits: {
        deadlineSeconds: 7200,
        finalizationSeconds: 30,
        inputFileBytes: 16 * 1024 * 1024,
        stagedInputBytes: 64 * 1024 * 1024,
        inputFiles: 100,
        inFlightTransfers: 2,
        exportBytes: 16 * 1024 * 1024,
        exportFiles: 100,
        unreferencedInputRetentionSeconds: 3600,
        exportRetentionSeconds: 86400,
      },
    },
  });
}
