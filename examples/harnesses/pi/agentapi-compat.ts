import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// AgentAPI 0.12.2 has no Pi agent profile. Its generic PTY mode recognizes a
// ready input prompt by a trailing ">" marker, so expose one above Pi's editor.
// AgentAPI still owns the HTTP API, terminal input, output parsing, and status.
export default function (pi: ExtensionAPI): void {
  pi.registerEntryRenderer("agentapi-reply", (entry) => ({
    render: (width: number) => [`Reply ${entry.id}`.slice(0, width)],
    invalidate: () => {},
  }));

  pi.on("session_start", async (_event, context) => {
    if (!context.hasUI) return;
    // Changing usage/footer rows can be mistaken for the final agent reply.
    context.ui.setFooter(() => ({ render: () => [], invalidate: () => {} }));
    context.ui.setWidget("agentapi-ready", [context.ui.theme.fg("dim", ">")]);
  });

  pi.on("before_agent_start", async (_event, context) => {
    if (!context.hasUI) return;
    // AgentAPI compares all old screen lines, so identical replies need a new
    // boundary before their text. Custom entries stay out of model context.
    pi.appendEntry("agentapi-reply");
  });
}
