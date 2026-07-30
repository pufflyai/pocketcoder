import {
	type CommandResponse,
	defineExtensionView,
	type GuestHost,
	unwrapCommandOutcome,
} from "@pstdio/sdk/extensions";
import type { PocketcoderSnapshot, PocketcoderTemplate, PocketcoderWorkspace } from "./snapshot";

const SNAPSHOT_COMMAND = "pocketcoder-monitor.snapshot";
const REFRESH_INTERVAL_MS = 10_000;

const styles = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: var(--chakra-colors-fg, CanvasText);
    background: var(--chakra-colors-bg, Canvas);
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  button { font: inherit; }
  .monitor {
    width: min(1180px, 100%);
    margin: 0 auto;
    padding: 28px 28px 48px;
  }
  .monitor__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 24px;
  }
  .monitor__eyebrow {
    margin: 0 0 4px;
    color: #5b8def;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .11em;
    text-transform: uppercase;
  }
  h1, h2, p { margin-top: 0; }
  h1 { margin-bottom: 6px; font-size: 25px; line-height: 1.2; letter-spacing: -.02em; }
  h2 { margin-bottom: 0; font-size: 15px; }
  .monitor__subtitle, .monitor__meta, .empty, .secondary {
    color: color-mix(in srgb, currentColor 62%, transparent);
  }
  .monitor__subtitle { margin-bottom: 0; }
  .refresh {
    min-width: 92px;
    border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    border-radius: 7px;
    padding: 7px 12px;
    color: inherit;
    background: color-mix(in srgb, currentColor 6%, transparent);
    cursor: pointer;
  }
  .refresh:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
  .refresh:disabled { cursor: wait; opacity: .62; }
  .summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .summary__card, .section {
    border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, currentColor 3%, transparent);
  }
  .summary__card { padding: 14px 16px; }
  .summary__value { display: block; margin-bottom: 2px; font-size: 22px; font-weight: 650; }
  .summary__label { color: color-mix(in srgb, currentColor 58%, transparent); font-size: 12px; }
  .live-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 7px;
    border-radius: 50%;
    background: #2ca56c;
    box-shadow: 0 0 0 3px color-mix(in srgb, #2ca56c 18%, transparent);
  }
  .errors { display: grid; gap: 8px; margin: 0 0 20px; }
  .error {
    border: 1px solid color-mix(in srgb, #e05b55 42%, transparent);
    border-radius: 8px;
    padding: 10px 12px;
    color: #d9534f;
    background: color-mix(in srgb, #e05b55 8%, transparent);
    white-space: pre-wrap;
  }
  .section { overflow: hidden; margin-bottom: 16px; }
  .section__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 13px 16px;
    border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  }
  .count {
    border-radius: 999px;
    padding: 2px 8px;
    color: color-mix(in srgb, currentColor 68%, transparent);
    background: color-mix(in srgb, currentColor 8%, transparent);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th {
    padding: 9px 16px;
    color: color-mix(in srgb, currentColor 52%, transparent);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .08em;
    text-align: left;
    text-transform: uppercase;
  }
  td {
    padding: 11px 16px;
    border-top: 1px solid color-mix(in srgb, currentColor 9%, transparent);
    vertical-align: middle;
  }
  tbody tr:hover { background: color-mix(in srgb, currentColor 3%, transparent); }
  .primary { font-weight: 570; }
  .secondary { margin-top: 2px; font-size: 11px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .badge {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 3px 8px;
    color: #4c7fd5;
    background: color-mix(in srgb, #5b8def 13%, transparent);
    font-size: 11px;
    font-weight: 650;
  }
  .badge--ready, .badge--active {
    color: #269665;
    background: color-mix(in srgb, #2ca56c 13%, transparent);
  }
  .badge--failed, .badge--retired {
    color: #d9534f;
    background: color-mix(in srgb, #e05b55 12%, transparent);
  }
  .empty { padding: 26px 16px; text-align: center; }
  @media (max-width: 720px) {
    .monitor { padding: 20px 14px 36px; }
    .monitor__header { align-items: stretch; flex-direction: column; }
    .refresh { align-self: flex-start; }
    .summary { grid-template-columns: 1fr; }
  }
`;

const element = <K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] => {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
};

const appendCell = (
	row: HTMLTableRowElement,
	primary: string,
	secondary?: string,
	className?: string,
) => {
	const cell = element("td");
	const value = element("div", `primary${className ? ` ${className}` : ""}`, primary);
	cell.append(value);
	if (secondary) cell.append(element("div", "secondary", secondary));
	row.append(cell);
};

const badge = (value: string) => element("span", `badge badge--${value.toLowerCase()}`, value);

const shortId = (value: string) => (value.length > 12 ? `${value.slice(0, 8)}…` : value);

const renderWorkspaces = (body: HTMLElement, workspaces: PocketcoderWorkspace[]) => {
	body.replaceChildren();
	if (workspaces.length === 0) {
		body.append(element("div", "empty", "No active PocketCoder workspaces."));
		return;
	}

	const wrap = element("div", "table-wrap");
	const table = element("table");
	const head = element("thead");
	const headerRow = element("tr");
	for (const label of ["State", "Workspace", "Template", "Reason"]) {
		headerRow.append(element("th", undefined, label));
	}
	head.append(headerRow);
	const rows = element("tbody");
	for (const workspace of workspaces) {
		const row = element("tr");
		const stateCell = element("td");
		stateCell.append(badge(workspace.state));
		row.append(stateCell);
		appendCell(row, workspace.external_id || "—", shortId(workspace.id), "mono");
		appendCell(row, workspace.template.name, workspace.template.version);
		appendCell(row, workspace.reason_code ?? "—");
		rows.append(row);
	}
	table.append(head, rows);
	wrap.append(table);
	body.append(wrap);
};

const renderTemplates = (body: HTMLElement, templates: PocketcoderTemplate[]) => {
	body.replaceChildren();
	if (templates.length === 0) {
		body.append(element("div", "empty", "No authorized PocketCoder templates."));
		return;
	}

	const wrap = element("div", "table-wrap");
	const table = element("table");
	const head = element("thead");
	const headerRow = element("tr");
	for (const label of ["Template", "Status", "Digest"]) {
		headerRow.append(element("th", undefined, label));
	}
	head.append(headerRow);
	const rows = element("tbody");
	for (const template of templates) {
		const row = element("tr");
		appendCell(row, template.name, template.version);
		const statusCell = element("td");
		statusCell.append(badge(template.status));
		row.append(statusCell);
		appendCell(row, shortId(template.digest), undefined, "mono");
		rows.append(row);
	}
	table.append(head, rows);
	wrap.append(table);
	body.append(wrap);
};

const executeSnapshot = async (host: GuestHost) => {
	const response = await host.call<CommandResponse<PocketcoderSnapshot>>("commands.execute", {
		commandId: SNAPSHOT_COMMAND,
	});
	return unwrapCommandOutcome(response, "Could not load PocketCoder monitor data.");
};

export default defineExtensionView({
	render({ mount, host }) {
		const style = element("style");
		style.textContent = styles;

		const page = element("main", "monitor");
		const header = element("header", "monitor__header");
		const heading = element("div");
		heading.append(
			element("p", "monitor__eyebrow", "Runtime overview"),
			element("h1", undefined, "PocketCoder Monitor"),
			element("p", "monitor__subtitle", "Active workspaces and authorized runtime templates."),
		);
		const refreshButton = element("button", "refresh", "Refresh");
		refreshButton.type = "button";
		header.append(heading, refreshButton);

		const summary = element("section", "summary");
		const workspacesValue = element("strong", "summary__value", "—");
		const templatesValue = element("strong", "summary__value", "—");
		const updatedValue = element("strong", "summary__value", "—");
		const workspaceCard = element("div", "summary__card");
		workspaceCard.append(workspacesValue, element("span", "summary__label", "Active workspaces"));
		const templateCard = element("div", "summary__card");
		templateCard.append(templatesValue, element("span", "summary__label", "Available versions"));
		const updatedCard = element("div", "summary__card");
		const updatedLabel = element("span", "summary__label");
		updatedLabel.append(
			element("span", "live-dot"),
			document.createTextNode("Auto-refreshes every 10s"),
		);
		updatedCard.append(updatedValue, updatedLabel);
		summary.append(workspaceCard, templateCard, updatedCard);

		const errors = element("section", "errors");
		errors.hidden = true;

		const workspaceSection = element("section", "section");
		const workspaceHeader = element("div", "section__header");
		const workspaceCount = element("span", "count", "0");
		workspaceHeader.append(element("h2", undefined, "Running workspaces"), workspaceCount);
		const workspaceBody = element("div");
		workspaceSection.append(workspaceHeader, workspaceBody);

		const templateSection = element("section", "section");
		const templateHeader = element("div", "section__header");
		const templateCount = element("span", "count", "0");
		templateHeader.append(element("h2", undefined, "Templates"), templateCount);
		const templateBody = element("div");
		templateSection.append(templateHeader, templateBody);

		page.append(header, summary, errors, workspaceSection, templateSection);
		mount.replaceChildren(style, page);

		let stopped = false;
		let refreshing = false;
		let timer: number | undefined;

		const schedule = () => {
			if (stopped) return;
			if (timer !== undefined) window.clearTimeout(timer);
			timer = window.setTimeout(() => void refresh(), REFRESH_INTERVAL_MS);
		};

		const showError = (message: string) => {
			errors.hidden = false;
			errors.replaceChildren(element("div", "error", message));
		};

		const render = (snapshot: PocketcoderSnapshot) => {
			workspacesValue.textContent = String(snapshot.workspaces.length);
			templatesValue.textContent = String(snapshot.templates.length);
			updatedValue.textContent = new Intl.DateTimeFormat(undefined, {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			}).format(new Date(snapshot.refreshedAt));
			workspaceCount.textContent = String(snapshot.workspaces.length);
			templateCount.textContent = String(snapshot.templates.length);
			renderWorkspaces(workspaceBody, snapshot.workspaces);
			renderTemplates(templateBody, snapshot.templates);

			errors.replaceChildren();
			errors.hidden = snapshot.errors.length === 0;
			for (const error of snapshot.errors) {
				errors.append(element("div", "error", `${error.source}: ${error.message}`));
			}
		};

		const refresh = async () => {
			if (stopped || refreshing) return;
			refreshing = true;
			refreshButton.disabled = true;
			refreshButton.textContent = "Refreshing…";
			try {
				render(await executeSnapshot(host));
			} catch (error) {
				showError(error instanceof Error ? error.message : String(error));
			} finally {
				refreshing = false;
				refreshButton.disabled = false;
				refreshButton.textContent = "Refresh";
				schedule();
			}
		};

		const onRefresh = () => void refresh();
		const onVisibilityChange = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		refreshButton.addEventListener("click", onRefresh);
		document.addEventListener("visibilitychange", onVisibilityChange);
		renderWorkspaces(workspaceBody, []);
		renderTemplates(templateBody, []);
		void refresh();

		return () => {
			stopped = true;
			if (timer !== undefined) window.clearTimeout(timer);
			refreshButton.removeEventListener("click", onRefresh);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	},
});
