# PocketCoder contributor guidance

Read the [product overview](README.md) and [security model](docs/security.md)
before changing behavior. PocketCoder runs coding agents in isolated
workspaces. Credentials a workspace can read must be scoped to that workspace
and expire with it.

## Work guidance

| Guide | When to use |
| --- | --- |
| [Engineering](docs/guidance/engineering.md) | Before writing or changing code. |
| [Testing and validation](docs/guidance/testing.md) | Every change, before choosing and running checks. |
| [Contributing](docs/guidance/contributing.md) | Before working with Git, packaging, or opening a PR. |
| [Pull requests and CI](docs/ci.md) | Opening, reviewing, or finishing a PR, or investigating CI failures. |
| [Planning and documentation](docs/guidance/planning.md) | Writing plans, tickets, documentation, or messages. |
| [Source layout](docs/source-layout.md) | Adding or moving packages, features, or dependencies. |

Follow the linked guidance for the work you do. Use Bun, keep tests green, and
never bypass the merge queue or required checks.
