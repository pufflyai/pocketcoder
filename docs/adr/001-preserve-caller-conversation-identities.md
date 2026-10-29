# 001: Preserve caller conversation identities across workspace generations

Status: Accepted for PC-115.

A physical PocketCoder workspace is replaced on resume. The calling service
already owns request acceptance and turn allocation. Scoping receipts to the physical
workspace or allocating another turn would break retries after replacement.

Store the supplied request context under `(principal, logical conversation,
request)`, independent of the physical generation. The physical workspace
provides authorization and content-write fencing. A unique PostgreSQL key makes
concurrent registration atomic. Keep the accepted context when transcript content
is deleted so deletion cannot reopen accepted request IDs. Generic callers must
explicitly choose generic authority and supply their own context.

Message storage binds to that receipt and scopes deduplication by logical
conversation, turn, event, and revision. Existing history stays unidentified.
Protocol support never advertises an installed producer capability.

This adds a small receipt table and requires a generated migration. It does not
own the caller's request normalization, turn allocation, dispatch, or draft links.
