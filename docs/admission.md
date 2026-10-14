# Workspace admission feedback

A workspace stays `queued` while controller limits or an external launch policy
prevent admission. GET/list/change responses expose a bounded `reason_code`:

| Code | Meaning |
| --- | --- |
| `admission_global_capacity` | The controller's global limit is full |
| `admission_principal_capacity` | The controller's principal limit is full |
| `admission_template_capacity` | The controller's template limit is full |
| `admission_policy_global_capacity` | The external policy reports its global capacity is full |
| `admission_actor_capacity` | The external policy reports its actor capacity is full |
| `admission_denied` | The policy refuses admission without a supported capacity reason |
| `admission_unavailable` | The policy is unreachable or returns an invalid/unavailable response |

Reasons describe the last checked decision, not a queue position or a promise of
capacity. The scheduler retries within the existing queue/deadline limits. It
does not increase limits or release stopping providers without termination proof.
An external actor reason applies only to the checked workspace; core does not
interpret tenant metadata or implement a business ledger.

Feedback changes bump `change_cursor` and wake change listeners. Repeating the
same reason does neither. Canceled, admitted and purged work cannot receive late
queued feedback. Cold and warm admission clear the reason atomically.

## External policy contract

Configure `POCKETCODER_LAUNCH_POLICY_URL` and a private
`POCKETCODER_LAUNCH_POLICY_TOKEN_FILE` outside every workspace. HTTPS is required
except for loopback tests. The controller POSTs workspace/principal/external ID,
template, launch mode and metadata; it never sends launch input or workspace keys.

Return HTTP 200 with `{"allowed":true,"workspace_id":"<matching UUID>"}` to
admit. Return HTTP 403 with the following body to report capacity:

```json
{"allowed":false,"reason":"active-capacity","scope":"actor"}
```

`scope` is `actor` or `global`. Other 403 bodies produce `admission_denied`;
their private text is not exposed. Malformed JSON, redirects, non-200/403 status,
wrong positive identity and transport errors never grant admission.

Programmatic `authorizeLaunch` callbacks may return true, false, or
`{ allowed: false, reason: <one of the bounded policy codes> }`. Controller limit
codes are reserved for local counters. Distinct policy codes keep retries from
clearing a denial when local capacity is free. The deployment owns the policy,
identities and quotas. A false callback produces `admission_denied`;
an exception produces `admission_unavailable`.
