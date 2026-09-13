# Source layout

Keep workspace packages under `packages/`. Group implementation and adjacent
tests by feature inside each package. A small package with one responsibility,
such as `auth`, can remain one module. Root files provide package entry points
and compose the feature modules.

| Package | Where to look |
| --- | --- |
| db | `modules/` for repositories, `database/` for client and lifecycle, `schema/` and `migrations/` for database definitions |
| memory-store | `modules/` for store behavior and `state/` for shared maps and counters |
| runtime-core | `scheduler/`, `reconciliation/`, `warm-pool/`, `registry/`, `outbox/`, and `observability/` |
| server | Feature routes and services in `workspaces/`, `persistence/`, `templates/`, `administration/`, `conversations/`, `attachments/`, and `terminals/`; transport code in `http/`, `relay/`, and `control-channel/` |
| drivers | `docker/`, `kubernetes/`, `filesystem/`, `secrets/`, and shared `egress/` |
| supervisor | `bootstrap/`, `agent/`, `proxy/`, `attachments/`, `terminals/`, `checkpoints/`, `warm-pool/`, and `observability/` |
| remote | `client/`, `session/`, `stream/`, `attachments/`, `history/`, and `ui/` |
| sdk | `resources/<resource>/` and shared `transport/` |
| contracts | Domain schemas in named feature directories; shared values in `common/` |
| runtime-contracts | `stores/`, `drivers/`, and `events/` |
| cli | `commands/<resource>/`, shared command setup in `command/`, and integration test support in `testing/` |
| testkit | `stores/`, `drivers/`, `agentapi/`, and `fixtures/` |
| egress | `proxy/`, `firewall/`, and `audit/` |

## Dependencies

Use package exports for cross-package imports. Runtime contracts do not import
database or provider implementations. Database repositories receive one Drizzle
context; memory repositories receive one state object. Scheduler and persistence
services receive their context and the other services they call.

Keep transaction ownership at the operation that needs atomic writes. For
example, a workspace transition passes its transaction to history and outbox
writes. Those helpers cannot commit independently.

## Moving or adding code

Put new behavior in its feature directory and pass the dependencies it uses.
Keep tests next to that behavior. Move shared code only when several features
use it; do not create a generic base class to split a long file.

When moving a file, update imports, package exports, subprocess paths, test
fixtures, build entries, and documentation links. The remote launcher must find
`src/extension.ts` during development and `dist/extension.js` after packaging.
The CLI and server builds must still include generated database migrations.

Use `bun run check`, `bun run typecheck`, and `bun run test` to validate changes.
Run `bun run pack:check` when published output changes. The formatter uses 120
columns and LF endings. Cognitive complexity and nested ternaries are lint
errors; simplify the code instead of disabling those rules.
