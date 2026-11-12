# Managed test changes for PC-186

Removed whole test files:

- `packages/contracts/src/sessions/artifacts.test.ts`: Generated static contract files were removed. Runtime OpenAPI and route tests cover the API.
- `packages/db/src/modules/managed/authority.test.ts`: Immutable profiles, scope grants, and owner provisioning were replaced by configured profiles.
- `packages/db/src/modules/managed/authority-locks.test.ts`: Budget scope locks and grants were removed. Owner placement tests cover the retained capacity lock.
- `packages/db/src/modules/managed/stored-records.test.ts`: Compatibility with old managed profiles and policies is explicitly removed.
- `packages/db/src/modules/budgets/policies.test.ts`: Budget policies, revisions, periods, and clock floors were removed.
- `packages/db/src/modules/budgets/capacity.test.ts`: Start ledgers and scope usage were removed. Owner capacity tests replace this coverage.
- `packages/db/src/modules/budgets/capacity-admission.test.ts`: Budget start admission was removed. Owner capacity and ordinary admission tests cover retained limits.

Updated tests keep request replay, generation fencing, cleanup evidence, scoped
cancel, input retention, collection, history and provider recovery. Tests of
caller-selected deadlines and stop IDs now cover profile-selected deadlines and
idempotent calls. Issuer tests now use fresh mints and generation revoke; identity
echo, deterministic re-mint and per-lease revoke assertions are obsolete.

The standalone consumer intent-file tests were removed with that storage helper.
The reference-consumer test instead reconstructs a consumer and resends the same
message directly. Contract tests retain Unicode and collection checks. New owner
capacity, configured-profile, feed reset, history seed and stateless-issuer tests
cover the replacement behavior.
