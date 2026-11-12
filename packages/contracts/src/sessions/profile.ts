import { z } from "zod";

export const ProfileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const ProfileConfigSchema = z.strictObject({
  template: z.string().min(1).max(128),
  templateVersion: z.string().min(1).max(128).optional(),
  issuer: ProfileNameSchema.optional(),
  placement: z.enum(["exclusive", "shared"]).default("exclusive"),
  limits: z
    .strictObject({
      workspacesPerOwner: z.number().int().positive().default(1),
      sessionsPerWorkspace: z.number().int().positive().default(1),
    })
    .default({ workspacesPerOwner: 1, sessionsPerWorkspace: 1 }),
  dispatchDeadlineSeconds: z.number().int().positive().default(600),
});
export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;
export const SessionProfileSchema = ProfileConfigSchema.extend({
  name: ProfileNameSchema,
  templateVersion: z.string().nullable(),
  disabled: z.boolean(),
});
export type SessionProfile = z.infer<typeof SessionProfileSchema>;

export const SessionCreateSchema = z.strictObject({
  sessionId: z.uuid(),
  profile: ProfileNameSchema,
  owner: z.string().min(1).max(128),
  group: z.string().min(1).max(128).optional(),
});
export type SessionCreate = z.infer<typeof SessionCreateSchema>;
export const SessionSchema = z.strictObject({
  sessionId: z.uuid(),
  profile: ProfileNameSchema,
  owner: z.string().min(1).max(128),
  group: z.string().min(1).max(128),
  revision: z.number().int().positive(),
  state: z.enum(["provisioning", "ready", "suspended", "closed", "failed"]),
  reasonCode: z.string().min(1).max(256).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Session = z.infer<typeof SessionSchema>;
