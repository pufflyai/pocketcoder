import { managedFixture, provision } from "../managed/fixture.test";
import { executionFixture } from "../workspaces/execution-fixture.test";
import { serviceExecutionTemplate } from "../workspaces/execution-service-fixture.test";

export async function sessionWorkFixture(mode: "memory" | "disk" = "memory", outputs = false) {
  const f = await managedFixture(mode);
  const execution = await executionFixture(
    (source) => {
      serviceExecutionTemplate(source);
      source.spec.operations = {
        message: {
          ...source.spec.operations.run!,
          outputRoots: outputs ? ["/outputs"] : [],
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
        },
      };
    },
    {
      base: f,
      capabilities: [
        "explicit-start",
        "exact-exit",
        "targeted-cancel",
        "request-lookup",
        "deduplicated-accept",
        "stop-before-export",
        "unknown-outcome",
        "parallel-conversations",
        "immutable-inputs",
        "explicit-publication",
      ],
    },
  );
  await f.store.publishTemplate(f.keyId, execution.runtime.template.manifest);
  f.profile.templateDigest = execution.runtime.template.digest;
  await provision(f);
  return { ...f, ...execution };
}
