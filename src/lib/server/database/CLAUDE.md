# database/

Database layer — PostgreSQL connection, schema migrations, and query modules.

## Files

| File                  | What                                                   | When to read                     |
| --------------------- | ------------------------------------------------------ | -------------------------------- |
| `base-schema.ts`      | Core database table definitions                        | Understanding database schema    |
| `connection.ts`       | PostgreSQL connection pool and Database class (legacy) | Setting up database connection   |
| `index.ts`            | Database module exports                                | Importing database functionality |
| `migrate-schema.ts`   | Schema migration execution                             | Running migrations               |
| `migration-system.ts` | Migration versioning and ordering system               | Managing migration lifecycle     |
| `typed-query.ts`      | Typed query helper utilities                           | Building type-safe queries       |

## Creating Migrations (CRITICAL: 2-step process)

Creating a migration file is NOT enough. You MUST also register it:

0. The whole history through `BASE_SCHEMA_VERSION` (see `base-schema.ts`) is squashed into
   `base-schema-sql.ts` and those files are deleted, so `migrations/` may be empty — create
   the directory if it is missing. A new migration's version must be ABOVE the highest
   version applied on every deployed database, not merely above the watermark. An existing
   database whose watermark is below `BASE_SCHEMA_VERSION` refuses to boot (`migration-system.ts`):
   only squash migrations every deployed database has already applied.
1. Create the migration file in `migrations/` with a named export matching the pattern `migration_X_Y_Z`
2. **Import and add it to the `MIGRATIONS` array in `migrate-schema.ts`** — without this step, the migration will never run on deploy

```typescript
// In migrate-schema.ts:
import { migration_16_468_0 } from './migrations/16.468.0_example_change.js';

const MIGRATIONS: Migration[] = [
    // ... existing migrations
    migration_16_468_0, // <-- ADD HERE
];
```

Migration files must export a `Migration` object with: `version`, `name`, `description`, `checksum`, and `up()`.

### `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` — `WHEN` still evaluates immediately

Deferring a `CONSTRAINT TRIGGER` to `INITIALLY DEFERRED` only defers the _firing of the
trigger function body_ to COMMIT — it does **not** defer evaluation of the trigger's
`WHEN` clause. Postgres evaluates `WHEN` immediately at the row operation (the
`UPDATE`/`INSERT` statement that changed the row), taking its `OLD`/`NEW` snapshot at
that instant. Only the function body execution is pushed to end-of-transaction. A `WHEN`
predicate or `NEW.`/`OLD.` reference that assumes commit-time values will silently see
the earlier, row-operation-time snapshot instead — no error, just a stale read.

Concrete example: `oauth_refresh_tokens_deactivate_push`, a `DEFERRABLE INITIALLY
DEFERRED` constraint trigger used specifically so a same-transaction revoke-then-reissue
(e.g. `RefreshTokenService.rotate()`) sees its own INSERT before the live-session check
runs at COMMIT. It is harmless today because the function body only reads
`NEW.user_id`/`NEW.device_id`, neither of which is mutated later in any revocation
transaction — this note generalizes the hazard so the next `DEFERRABLE` constraint
trigger in this codebase doesn't rediscover it the hard way. The trigger now lives in
the squashed base schema (it arrived as migration `16.200.0`, folded in on 2026-08-25 —
see git history for the original file and its `## Why DEFERRABLE INITIALLY DEFERRED`
rationale). Changing its behavior means shipping a NEW migration, never editing the
base snapshot.

## SQL traps (all invisible to mocked-`sql` unit tests; cover them with an integration test)

- **A bound `NULL` defeats a column `DEFAULT`.** A default applies only when the column is left out
  of the insert or given the keyword `DEFAULT`. `params.source ?? null` inserts a `NULL` and fails a
  `NOT NULL` column. Name the default in code (`params.source ?? 'x'`) or omit the column.
- **A nullable column in a unique key needs two changes together.** Use `UNIQUE NULLS NOT DISTINCT`
  so `ON CONFLICT DO NOTHING` sees the conflict, and `col IS NOT DISTINCT FROM ${value}` in every
  lookup, because `= NULL` is never true. With only the first, the insert is suppressed and the
  follow-up `SELECT` cannot find the row. Before widening a column to allow `NULL`, grep every
  `= ${col}` and every `ON CONFLICT (...)` that names it. Test at the election seam: call it twice and
  expect `elected: false` and the same row id.
- **A `CASE WHEN` cast does not guard a bound parameter.** In
  `CASE WHEN ${id}::text ~ ${PATTERN} THEN ${id}::uuid END` Postgres folds the parameter cast first,
  so a bad id still raises `22P02`. Validate parameter-shaped ids in JS and return early; keep the
  `CASE` guard for columns.
- **"Insert if the count is below N" is not a limiter.** Under `READ COMMITTED` each statement
  takes its own snapshot, so concurrent callers all see the old count. Take a per-key advisory lock
  inside the transaction (`pg_advisory_xact_lock(ns, hashtext(key))`; `plugins/shoutbox/lib/rate-limit-lock.js`
  is an example) and block rather than `try_` the lock, so contention and "over the limit" stay
  different answers.
- **Container rows own no file rows.** `tv`, `season`, `artist` and `album` rows never own
  `media_file_items`; only episodes, tracks and movies do. A predicate such as
  `NOT EXISTS (file rows of <container>) OR ...` is always true on a container, so the whole library
  filter silently does nothing. Judge a container through its leaf descendants or use
  `buildLibraryAccessFilter` instead of hand-inlining a copy.

## Subdirectories

| Directory     | What                                                                                                                       | When to read                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `__tests__/`  | Database unit tests                                                                                                        | Writing database tests         |
| `migrations/` | Incremental migrations newer than `BASE_SCHEMA_VERSION`. Empty right after a squash — recreate it when adding the next one | Creating or running migrations |
| `queries/`    | Pure SQL query modules (53 files)                                                                                          | Writing database queries       |
| `utils/`      | Database utility functions                                                                                                 | Using database helpers         |
