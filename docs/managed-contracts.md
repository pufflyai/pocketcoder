# Managed session contract

The running controller's `/v1/openapi.json` and the Zod schemas under
`packages/contracts/src/sessions` define the API. The SDK parses replies with
those same schemas. There is no separate generated schema bundle, route marker
or cross-language fingerprint vector file.

[Managed sessions](managed-runtime.md) explains configuration, placement and
limits. [Session work](managed-session-work.md) describes requests, files,
receipts and the conversation feed. [Consumer setup](managed-consumers.md) shows
the backend boundary.

## Ownership

- The principal comes from authentication, never a session request body.
- Profile names are scoped to their principal. Owners and groups are opaque
  consumer IDs and are never treated as credentials.
- Acceptance, input pins, queue charges, request identity and events commit in
  one transaction. The canonical conversation owns the history.
- Physical bindings retain a revision, generation and incarnation fence. A
  replacement cannot write as a previous generation or reuse its credentials.
- Capacity is reserved before launch and stays charged until cleanup evidence.
  Sharing and draining use the same transaction owners as dispatch.
- A request's logical fingerprint covers its message and ordered attachment
  IDs. Physical fingerprints remain controller-owned execution details.
- A session becomes ready only after its workspace acknowledges all required
  credential slots. Late credentials and late refusals cannot affect a closed
  session or a replacement generation.

## Migration and tests

The pre-1.0 API change is released with minor changesets for the CLI and SDK.
Managed data is deliberately recreated. Existing plain workspaces, templates,
secrets and conversations are retained.

Tests live beside profiles, placement, requests, history, credentials, SDK calls
and CLI commands. Tests for deleted scope grants, policies, immutable profile
revisions, binding expiry and generated artifacts are obsolete. Their
[disposition](managed-test-disposition.md) records the replacements. Live Pi,
Lab and provider tests exercise the production transport and workspace drivers.
