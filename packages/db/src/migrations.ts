// Ordered, immutable migrations. `{{schema}}` is replaced with the validated
// configured schema. Applied checksums may never change; add new migrations
// instead of editing existing ones.

export interface Migration {
	version: string;
	up: string;
}

export const MIGRATIONS: Migration[] = [
	{
		version: "0001_initial",
		up: `
CREATE TABLE {{schema}}.templates (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	version text NOT NULL,
	digest text NOT NULL UNIQUE,
	description text,
	spec jsonb NOT NULL,
	status text NOT NULL,
	created_at timestamptz NOT NULL,
	retired_at timestamptz,
	UNIQUE (name, version)
);

CREATE TABLE {{schema}}.principals (
	id uuid PRIMARY KEY,
	name text NOT NULL UNIQUE,
	scopes text[] NOT NULL,
	template_names text[] NOT NULL,
	disabled_at timestamptz,
	created_at timestamptz NOT NULL
);

CREATE TABLE {{schema}}.machine_keys (
	id uuid PRIMARY KEY,
	principal_id uuid NOT NULL REFERENCES {{schema}}.principals (id),
	secret_digest bytea NOT NULL,
	scopes text[] NOT NULL,
	created_at timestamptz NOT NULL,
	expires_at timestamptz,
	revoked_at timestamptz,
	last_used_at timestamptz
);

CREATE TABLE {{schema}}.workspaces (
	id uuid PRIMARY KEY,
	principal_id uuid NOT NULL REFERENCES {{schema}}.principals (id),
	external_id text NOT NULL,
	idempotency_key text NOT NULL,
	request_digest text NOT NULL,
	template_id uuid NOT NULL REFERENCES {{schema}}.templates (id),
	template_name text NOT NULL,
	template_version text NOT NULL,
	template_digest text NOT NULL,
	template_snapshot jsonb NOT NULL,
	state text NOT NULL,
	reason_code text,
	terminal_intent text,
	launch_input jsonb,
	provider_kind text,
	provider_ref jsonb,
	registration_digest bytea,
	registration_expires_at timestamptz,
	reconnect_digest bytea,
	connection_epoch integer NOT NULL DEFAULT 0,
	connected_at timestamptz,
	disconnected_at timestamptz,
	ready_at timestamptz,
	last_activity_at timestamptz,
	launch_attempts integer NOT NULL DEFAULT 0,
	health jsonb NOT NULL DEFAULT '{}'::jsonb,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	deadline_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL,
	updated_at timestamptz NOT NULL,
	terminal_at timestamptz,
	UNIQUE (principal_id, idempotency_key)
);

CREATE UNIQUE INDEX workspaces_principal_external_active
	ON {{schema}}.workspaces (principal_id, external_id)
	WHERE state NOT IN ('succeeded', 'failed', 'canceled', 'expired');

CREATE INDEX workspaces_state_created ON {{schema}}.workspaces (state, created_at);
CREATE INDEX workspaces_deadline ON {{schema}}.workspaces (deadline_at)
	WHERE state NOT IN ('succeeded', 'failed', 'canceled', 'expired');

CREATE TABLE {{schema}}.workspace_state_history (
	id uuid PRIMARY KEY,
	workspace_id uuid NOT NULL REFERENCES {{schema}}.workspaces (id),
	from_state text,
	to_state text NOT NULL,
	reason_code text,
	occurred_at timestamptz NOT NULL
);

CREATE INDEX workspace_state_history_ws
	ON {{schema}}.workspace_state_history (workspace_id, occurred_at);

CREATE TABLE {{schema}}.workspace_logs (
	workspace_id uuid NOT NULL REFERENCES {{schema}}.workspaces (id),
	seq bigint NOT NULL,
	stream text NOT NULL,
	occurred_at timestamptz NOT NULL,
	content bytea NOT NULL,
	PRIMARY KEY (workspace_id, seq)
);

CREATE TABLE {{schema}}.event_outbox (
	id uuid PRIMARY KEY,
	workspace_id uuid NOT NULL REFERENCES {{schema}}.workspaces (id),
	event_type text NOT NULL,
	payload jsonb NOT NULL,
	occurred_at timestamptz NOT NULL,
	next_attempt_at timestamptz NOT NULL,
	attempt_count integer NOT NULL DEFAULT 0,
	delivered_at timestamptz,
	last_error_code text
);

CREATE INDEX event_outbox_due ON {{schema}}.event_outbox (next_attempt_at)
	WHERE delivered_at IS NULL;
`,
	},
];
