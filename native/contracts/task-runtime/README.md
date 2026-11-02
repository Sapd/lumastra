# Task runtime protocol v1

Status: compatibility seed with executable TypeScript framing/schema fixtures.
No command listener, durable receipt store or ownership handoff is implemented by
these files. Rust task ownership remains blocked on the complete T03 writer audit
and fault tests. T01 continues to use the existing supported TypeScript BullMQ
implementation, queue names, Lua script versions and PostgreSQL history.

The executable schemas are `src/task-runtime/protocol.ts`; metadata projection is
`src/task-runtime/catalog.ts`. Change these contracts together with fixtures and
all consumers. An unknown version fails validation; there is no silent downgrade.

## Transport and limits

- Web commands: authenticated private HTTP, with a dedicated deployment secret
  supplied by the existing sealed configuration path. No command endpoint is
  exposed by the T01 health server. Metrics credentials cannot authorize control.
- Local control/execution: Unix socket owned by the runtime UID, mode `0600`, in
  a runtime-owned `0700` directory; fail startup if those permissions/ownership
  cannot be established. Never place it on a shared writable media directory.
- Each local frame is a four-byte unsigned big-endian UTF-8 byte length followed
  by exactly that many bytes of JSON. Maximum body is 262,144 bytes. Empty,
  oversized, truncated, malformed JSON or invalid UTF-8 frames terminate the
  connection. An oversized header is rejected before its body is retained.
- At most 32 outstanding requests per connection, and 32 decoded frames per
  batch. Pause reads when capacity is exhausted; bounded writes must await drain.
  The parser is not the connection supervisor and alone cannot enforce an
  outstanding-request budget. Request deadline is 30 seconds; a timeout has an
  unknown outcome and must retry with the same command ID and content.
- UUID command/correlation IDs are distinct from run IDs. Owner ID is a boot
  identity. Generation is positive decimal text bounded by signed PostgreSQL
  bigint, preserving values beyond JavaScript's safe integer range.

## Durable command semantics (T03 prerequisite)

A command carries partition, owner ID, generation and catalog revision. `submit`,
`cancel` and `drain` are semantic operations through the TypeScript adapter,
never raw Redis operations or serialized BullMQ jobs. Payload is JSON validated
again by the existing SDK/input/options validators. TaskContext, functions,
credentials, SQL handles and secret values are never protocol services/catalog
fields. User task input remains subject to its existing input validation and
redaction policy; protocol logging must not dump command payloads.

The adapter must commit command ID, immutable request digest, accepted state and
receipt atomically before sending `accepted`. Reusing an ID with different
content is an error. Returning an existing durable receipt is read-only; it must
not repeat a mutation. No successful acknowledgement is inferred from a socket
write or a queued in-memory callback. `completed` describes command processing,
not necessarily terminal task execution. Error responses use bounded codes;
stack traces, SQL errors, URLs, credentials and raw plugin errors stay local.

Every control mutation validates the current durable generation in the mutation
transaction or atomic script, including retries, terminal writers, recovery,
scheduler state, pending-write replay and administrative paths. Checking a token
once at process startup is insufficient. Existing unfenced code must be excluded
from consumers/leadership before any handoff. SDK SQL/external side effects need
a confirmed drain or an audited mediated boundary. External effects remain
at-least-once; uncertain effects require reconciliation.

Handoff closes admission, durably retains submissions, drains/checkpoints active
work, verifies children stopped, atomically advances generation, activates the
new owner and reconciles receipts before reopening admission. Rollback repeats
that sequence with a higher generation to the T03-fenced TypeScript owner.
Per-task queues and every queue/claim boundary in the full dependency/exclusivity
partition must be verified before partial ownership. Legacy shared-class queues
block that canary. There is no queue flush or old-image rollback shortcut.

## Catalog and execution placement

Catalog revision is SHA-256 of normalized, sorted UTF-8 JSON metadata. Publication
must be atomic. SDK ABI stays 1 and all eleven contract kinds remain registered
by TypeScript: task, provider, trickplay, watch-sync, feature, integration,
external-service, media-source, subtitle-provider, lyrics-provider, auth-provider.
Only tasks enter the execution catalog. Other contracts retain their current
provider/feature/service placement and initialization lifetimes.

The catalog projects metadata explicitly, without serializing definitions,
contexts, schemas, secrets or functions. Input validation, identity/retry
predicates, dynamic schedule loaders and pipeline `when` callbacks stay owned by
the TypeScript SDK host. The present catalog marks these opaque policies;
consumers cannot interpret those markers as native policy implementations.
`inline` remains inline; worker isolation keeps the existing capability checks,
restricted context and feature flag/bundle fallback behavior. Dependency/drain
and service-backed tasks must not be silently moved into the restricted sandbox.
Reusable host lifetime remains the existing TaskRunner process; no per-run cold
Node process or new executor pool is introduced by C01/T01.

See `ownership-inventory.json` for audited seams and outstanding categories. That
inventory is a starting checklist, not proof that every production writer has
been fenced. T03 cannot be accepted from protocol-only tests.
