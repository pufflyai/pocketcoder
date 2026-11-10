import { defineCommand, definePage, defineView, qualifyRef, workbenchModes } from "@pstdio/sdk/extensions";
import { instancesFor } from "./instances";
import { instancePageRef } from "./lab-navigation";
import { relaunchMachine, resumeMachine } from "./machine-lifecycle";
import { type ControllerMachine, machinePath } from "./machines";
import { machineKind } from "./resources";
import { machineTarget } from "./table-commands";

const owner = "pocketcoder.pocketcoder";
function lifecycleDialog(action: "relaunch" | "resume") {
  const title = action === "relaunch" ? "Relaunch machine" : "Resume machine";
  const command = action === "relaunch" ? relaunchMachine : resumeMachine;
  const view = defineView({
    id: `machines.${action}`,
    title,
    body: {
      kind: "controls",
      async query(ctx, { renderer }) {
        const target = machineTarget({ resource: renderer.resource });
        const source = await instancesFor(ctx.projectId).request<ControllerMachine>(
          target.instance,
          machinePath(target.machineId),
        );
        if (action === "resume" && !source.persistence.enabled)
          return {
            readOnly: true,
            params: [
              {
                id: "unavailable",
                name: "Resume unavailable",
                type: "readOnly",
                value:
                  "This template does not save checkpoints. Use Relaunch machine with fresh launch input to start again.",
              },
            ],
          };
        return {
          params: [
            {
              id: "source",
              name: "Source machine",
              type: "readOnly",
              value: `${source.external_id} · ${source.template.name}@${source.template.version}`,
            },
            {
              id: "behavior",
              name: "New machine",
              type: "readOnly",
              value:
                action === "relaunch"
                  ? "Apply to launch a fresh machine from this template. Files and conversation start empty. The original machine stays unchanged."
                  : "Apply to restore the latest ready checkpoint into a new machine, including its saved files and conversation. The original machine stays unchanged.",
            },
            {
              id: "credentials",
              name: "Fresh credentials",
              type: "readOnly",
              value:
                "Supply new one-time launch input if the template needs it. Application metadata and relay device/workspace IDs are not copied; supply the new machine's values below.",
            },
            {
              id: "externalId",
              name: "Application task ID (optional)",
              type: "text",
              singleLine: true,
              defaultValue: "",
            },
            { id: "launchInput", name: "Fresh one-time launch input (JSON, optional)", type: "text", defaultValue: "" },
            { id: "metadata", name: "New application metadata (JSON, optional)", type: "text", defaultValue: "" },
            {
              id: "connection",
              name: "Agent connection",
              type: "selection",
              defaultValue: source.metadata["pstdio.connection"] ?? "agentapi",
              options: [
                { id: "agentapi", name: "AgentAPI" },
                { id: "relay", name: "Prompt Studio Cloud relay" },
              ],
            },
          ],
        };
      },
      async onApply(ctx, { renderer, values }) {
        const result = await ctx.commands.execute(command.ref, {
          params: {
            ...machineTarget({ resource: renderer.resource }),
            externalId: String(values.externalId ?? ""),
            launchInput: String(values.launchInput ?? ""),
            metadata: String(values.metadata ?? ""),
            connection: String(values.connection ?? "agentapi"),
          },
        });
        if (result.status !== "success") throw new Error(result.reason ?? `Could not ${action} machine.`);
        ctx.notify.toast({
          type: "success",
          message: "New machine queued. Close this dialog and connect when it is ready.",
        });
      },
    },
  });
  const page = definePage({
    id: `machines.${action}`,
    title,
    path: `pocketcoder-${action}`,
    mode: workbenchModes.project,
    parent: instancePageRef,
    resource: { kinds: [machineKind.ref] },
    main: { kind: "view", view: view.ref, presentation: "page", cardinality: "one" },
    slots: [],
  });
  const open = defineCommand({
    id: `machines.${action}-row`,
    title,
    async run(ctx) {
      machineTarget(ctx);
      ctx.navigation.open({ kind: "dialog", page: qualifyRef(owner, page.ref), resource: ctx.resource });
    },
  });
  return { view, page, open };
}

export const relaunchDialog = lifecycleDialog("relaunch");
export const resumeDialog = lifecycleDialog("resume");
