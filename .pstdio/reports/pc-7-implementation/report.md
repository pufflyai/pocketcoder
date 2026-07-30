---
report_name: "pc-7-implementation"
kind: "validation"
created: "2026-07-30T13:09:41.949Z"
draft: false
---

# Report

## Confidence Score

5/5

## Summary

Moved the three checked-in placeholder/conformance manifests from
`deploy/templates` to `examples/templates`, updated all local-development,
test, Compose, and documentation paths, and clarified that production
deployments supply their own reviewed templates. The running local server was
restarted against the new directory and retained the same active template
catalog.

## Validation Evidence

- Template validation: 3/3 manifests valid.
- Unit tests: `packages/cli/src/index.test.ts` passed 20/20.
- Compose validation: `docker compose ... config --quiet` passed.
- Formatting/static validation: targeted Biome check and `git diff --check`
  passed.
- Runtime verification: server restarted on port 7081, authenticated
  `templates list` returned all three active templates, and OpenAPI returned
  HTTP 200.

## Change Requests

None.

## Artifacts

- [Validation command output](files/validation.txt)

## Follow-up

None.
