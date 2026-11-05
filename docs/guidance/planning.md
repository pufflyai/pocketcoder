# Planning and documentation

## Language

Use simple English in plans, explanations, documentation, tickets, comments, and messages.

- Write short, direct sentences.
- Use plain words instead of jargon.
- Explain technical terms that readers may not know.

## Tickets (pstdio)

Tickets (`PC-XXX`) are managed with the pstdio CLI. After editing a ticket, save it: `pst tickets save --id PC-XXX`. See `pst --help`.

## Documentation

Keep product documentation in `docs/`. Start with the [documentation index](../README.md).
Use `docs/guidance/` for shared contributor rules. Link to the document that owns
a rule rather than keeping copies in several places. Keep existing product
paths stable; group new related documents when a topic needs several pages.

Check commands, configuration defaults, versions and links against current
source. Distinguish shipped behavior, proposed work and known validation gaps.
Do not describe a proposal or an untested candidate as a completed release.

Keep architecture decisions short. Explain the problem, the chosen approach,
the alternatives and their costs. Mark temporary workarounds and state what
allows their removal. Record recurring failure causes with focused evidence.

## Troubleshooting

Reproduce the failure with the smallest useful case. Read related architecture
and security docs, trace the failure to its owner, and fix the cause. Separate
confirmed facts from guesses. Report unresolved blockers with logs and the next
step needed to resolve them.
