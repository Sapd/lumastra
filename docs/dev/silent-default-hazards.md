<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Silent default hazards

Durable lessons from this codebase's worst bug class. Read it before touching an
access filter, an API contract, a paginated query, or any function whose "safe"
behaviour depends on an argument arriving.

## 1. The hazard class: silent, not loud

The bugs that hurt this repo do not crash, fail a test, or stand out in a diff.
They are **absences** and **permissive defaults** — the code compiles, the happy
path returns data, review sees plausible SQL. The damage is that it returns _too
much_ data, to the wrong caller, quietly. Concrete shapes we have actually
shipped and fixed:

- **`null`-means-allow-everything access filters.** The old media-access
  parameter pair was `{ deniedGroupIds: string[] | null; ageRating: … | null }`,
  where `null` meant "filter nothing." _Omitting_ the argument silently returned
  unfiltered rows, and "this caller may see nothing" was literally
  inexpressible (`src/lib/server/database/queries/builders/media-access-boundary.ts:6-12`).
- **Fail-open fallbacks.** The invariants suite records real ones: a
  name-identical `filterAccessibleMediaIds` copy that returned _every_ id on
  `!user`, a `/watch` gate that fell back to `Promise.resolve(true)`, stats
  endpoints caching unfiltered payloads under a shared key
  (`src/lib/server/utils/access-boundary-invariants.test.ts`).
- **Request schema declared in two places.** `/api/v1` routes validated query
  params with a runtime `def.request` Zod schema while the _published_ OpenAPI
  spec was generated from a separate hand-authored `_openapi.ts`. They drifted:
  the backend accepted params the spec never exposed, so generated clients
  (tvOS Swift, TS) could not send them — the param silently did nothing. Fixed
  by deriving the spec _from_ `def.request` (guards in
  `scripts/openapi/generate-public.ts`).
- **Offset pagination on a mutable sort key.** `LIMIT/OFFSET` over a column that
  rows move within between pages silently **skips or duplicates** rows. Worse,
  Postgres `timestamptz` is microsecond-precision but JS `Date` is
  millisecond — round-tripping a keyset cursor through `Date` drops a row
  updated in the same millisecond as the page boundary
  (`src/lib/server/database/queries/builders/keyset-cursor.builder.ts:4-32`).
- **Same-typed positional args swapped.** Two `string[] | null` (or two
  same-shaped) positionals transpose without a type error and produce unfiltered
  or mis-filtered data. Nothing in the type or the diff objects.

The common thread: **the failure is a missing restriction, and missing things
don't show up.** No exception, no red test, no suspicious line to review.

## 2. The principle: safe-by-default, unsafe-by-explicit-greppable-choice

Make the illegal state **unrepresentable in the type**, not merely discouraged
by docs or "an access token appears in this file" lint. If a caller wants the
dangerous behaviour, they must _name_ it, and that name must be greppable.

The worked example is `MediaAccessBoundary`
(`src/lib/server/database/queries/builders/media-access-boundary.ts`). It
replaced the permissive pair with two **required** axes, each a named variant:

```
LibraryScope = { kind: 'all' } | { kind: 'denyGroups'; ids } | { kind: 'denyAll' }
AgeScope     = { kind: 'any' } | { kind: 'limit'; … }          | { kind: 'denyAll' }
```

There is no default. A caller that genuinely wants no filtering must call
`unrestrictedAccess()` (`:83`) — so every such decision is one `grep` away from
an auditor. "See nothing" is now expressible (`denyAllAccess()`, `:95`) instead
of faked with `maxAgeRating: -1`. Omitting the argument is a **compile error**,
not a silent open door. Contrast the related-but-weaker guard in
`resolve-and-gate.ts`, which throws `MediaAccessDeniedError` and maps to **404,
not 403** (`:16`, `:33`) so the response itself doesn't leak existence — another
"safe by default" choice baked into the shape of the API.

Apply the same move elsewhere: a mutable-sort paginator should hand back an
opaque keyset cursor, not a raw `offset` the caller can compute wrong; a
two-`string[]` signature should become one named object so the args can't
transpose.

## 3. The enforcement ladder (in order of durability)

**types > differential tests > lint > docs.** Prefer the highest rung the
problem allows; the lower rungs are backstops, not substitutes.

1. **Types** — the only rung that makes the bad state _impossible to write_.
   `MediaAccessBoundary`'s required axes are this rung. For a long time this repo's
   type layer was effectively disabled (`tsc` OOMed on the project, `vite build`
   only transpiles, so type errors shipped silently). The **tsgo gate**
   (`scripts/typecheck/tsgo-check.mjs`, run by `npm run typecheck` and blocking in
   CI) restores it: zero type errors, in scope, or the build is red. The
   interim ratchet that only forbade _new_ errors was retired once the backlog
   reached zero.

2. **Differential tests** — verify _behaviour_ where a type can't. The key
   insight: **token-presence lint cannot check that a filter is correct or that
   an argument arrived.** `no-unscoped-media-items`
   (`scripts/eslint-plugin-callback-safety/rules/no-unscoped-media-items.js:18-19`)
   says so itself — it passes any `sql` template in a file that merely _mentions_
   one of ~25 marker tokens _anywhere_. It cannot tell whether the fragment was
   appended to the WHERE or built and dropped, whether the boundary arg carried a
   real value or a permissive default, or whether it landed on the right alias.
   The behavioural guard is a **differential test**: run the query twice — once
   unrestricted, once restricted — and assert the restricted result is a strict
   subset of the unrestricted one, and that `denyAll` returns empty. A positive
   control (unrestricted must be non-empty) keeps the deny assertion load-bearing
   instead of vacuously passing on a swallowed error. The shared helper for this
   is `expectAccessFiltered`; consolidate to the one copy rather than re-deriving the invariant per file.

3. **Lint** — cheap, fast, catches the _shape_ of a mistake (a `media_items`
   read with no access marker in scope; `sql.unsafe()`; direct `external_ids`
   writes). Necessary as a first tripwire, but it verifies _presence of a token_,
   never _correctness of behaviour_. Never let a green lint stand in for rung 1
   or 2.

4. **Docs** — this file. Zero enforcement. It records _why_, so the higher rungs
   don't get quietly weakened by someone who doesn't know what they're for.

If you find yourself protecting an invariant with docs only, ask what stops the
next person: can it be a type? if not, a differential test? if not, at least a
lint tripwire?

## 4. Verification discipline: match rigor to blast radius

Not every change earns the same scrutiny — but you decide the tier _before_ you
start, by the change's blast radius, and you **never trust a change's own claim
of success.** Run the gate.

- **Mechanical / reversible** (a rename, a doc, a local refactor with a green
  differential test): light touch. Make it, run the relevant test/lint, move on.
- **Security / API-contract / one-way-door** (anything touching an access
  boundary, the published OpenAPI spec, a migration, a cache key, cursor
  encoding, or a signature two callers pass same-typed args to): **adversarial**.
  Assume it fails open. Prove the restriction with a differential test that
  includes a positive control. Get an **independent cross-check** (a second
  reviewer or a separate test asserting the invariant from outside), and a
  **human gate** before it ships. These are exactly the changes where a silent
  default does the most damage and shows the least.

Concretely: a passing build proves the code transpiled, nothing more. "The tests
pass" is only meaningful if a test actually exercises the restricted path — the
invariants suite exists precisely because a permissive arg or a resurrected
fail-open helper produces **no** failing test on its own
(`access-boundary-invariants.test.ts` header). Run the real gate, read its
output, and make the assertion load-bearing before you call it done.
