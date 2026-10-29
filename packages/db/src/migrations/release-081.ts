// 0.8.1 shipped one migration that the 1.0 chain does not contain. 1.0 has the same
// statements inside "20261014100009_marvelous_praxagora", plus two reason-code constraints.
// Shipped migrations never change, so the upgrade reconciles the history instead.
export const RELEASE_081_MIGRATION = {
  name: "20261013125843_tiny_marvel_zombies",
  hash: "396ef381367d4a2842a231f774b3e943006daabefb2f28164e35aa6f8a8c9e6b",
  replacedBy: "20261014100009_marvelous_praxagora",
  sql: [
    'CREATE TABLE "conversation_requests" (\n\t"principal_id" uuid,\n\t"conversation_id" uuid,\n\t"request_id" uuid,\n\t"identity" jsonb NOT NULL,\n\t"accepted_at" timestamp with time zone NOT NULL,\n\tCONSTRAINT "conversation_requests_pkey" PRIMARY KEY("principal_id","conversation_id","request_id")\n);\n',
    '\nALTER TABLE "workspace_conversation_messages" ADD COLUMN "identity" jsonb;',
    '\nALTER TABLE "conversation_requests" ADD CONSTRAINT "conversation_requests_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id");',
  ],
} as const;
