import { z } from "zod";

// A deliberate JSON Schema subset keeps operation input portable across adapters.
// Unknown keywords fail instead of being silently ignored by one producer.
export type WorkloadInputProperty =
  | { type: "string" | "number" | "integer" | "boolean" | "null" }
  | { type: "array"; items: WorkloadInputProperty }
  | WorkloadInputObject;
export interface WorkloadInputObject {
  type: "object";
  properties: Record<string, WorkloadInputProperty>;
  required: string[];
  additionalProperties: false;
}

const InputPropertySchema: z.ZodType<WorkloadInputProperty> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({ type: z.enum(["string", "number", "integer", "boolean", "null"]) }),
    z.strictObject({ type: z.literal("array"), items: InputPropertySchema }),
    WorkloadInputSchema,
  ]),
);

export const WorkloadInputSchema = z
  .strictObject({
    type: z.literal("object"),
    properties: z.record(z.string(), InputPropertySchema),
    required: z.array(z.string()).default([]),
    additionalProperties: z.literal(false),
  })
  .superRefine((schema, ctx) => {
    if (
      new Set(schema.required).size !== schema.required.length ||
      schema.required.some((name) => !Object.hasOwn(schema.properties, name))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["required"],
        message: "required input properties must be declared and unique",
      });
    }
  });
