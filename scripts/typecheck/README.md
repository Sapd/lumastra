<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Typecheck gate (tsgo)

The repo's real type-checking gate. `npm run typecheck` generates the codegen the
type-checker needs, then runs **`tsgo`** (TypeScript 7, the Go-native compiler) over
the whole SvelteKit project and **fails on any type error**.

```bash
npm run typecheck                            # blocking: non-zero exit on any error
TYPECHECK_REPORT_ONLY=1 npm run typecheck    # print the count, always exit 0
```

## Why tsgo

- `tsc --noEmit` OOMs on this project without an 8 GB heap and takes minutes.
- `vite build` only transpiles — it never type-checks.
- `svelte-check` is broken on this toolchain (Node 25 / a TS6-assertion crash).

The native compiler type-checks the full program in ~25 s with no crash, with full
SvelteKit support.

It is now the **released TypeScript 7**, installed as a normal devDependency under the
alias `@typescript/native` (`npm:typescript@~7.0.2`) and addressed by path from
`tsgo-run.mjs`, which the gate and the headroom probe share so the two cannot drift
onto different compilers. The alias name is the one `svelte-check --tsgo` looks for, so
`npm run check:svelte-types` runs on the same compiler. That replaces the old `npx -p @typescript/native-preview@…`
dev preview, which was re-fetched over the network on every run.

**Why `typescript` itself stays on 6.** TypeScript 7's package ships the Go binary and
no JS compiler API — `require('typescript').createProgram` is `undefined` — and
@typescript-eslint (which caps its peer at `<6.1.0`), svelte-check and svelte2tsx all
consume that API. Until they ship TS7 support, 6 is the API package and 7 is the
checker. `node_modules/.bin/tsc` resolves to the 7 binary because both packages
declare that bin name; nothing in this repo invokes bare `tsc`, and the gate uses the
explicit path either way.

## What it needs first

`npm run typecheck` runs these before `tsgo` (all reproduced from committed inputs;
a fresh checkout lacks them because they are gitignored generated files):

1. `svelte-kit sync` — `tsconfig.json` extends the gitignored `.svelte-kit/tsconfig.json`.
2. `paraglide:compile` — generates `src/lib/paraglide/*` (i18n messages).
3. `openapi:types` — generates `src/lib/api/schema.d.ts` from `docs/api/openapi.yaml`.

The Dockerfile gets these via `npm run build`; the standalone gate makes them explicit.

## CI

`.github/workflows/typecheck.yml` runs this on every PR and push to `main` on the
Linux runner, **blocking** (a type error fails the check). It is standalone, so it
gates PR merges but not `docker-publish`/deploy directly.

## Headroom probe

```bash
npm run typecheck:headroom              # default +250 synthetic routes, ~20s
node scripts/typecheck/headroom-check.mjs --routes 500
```

The gate is a **cliff, not a ramp** — it reads a clean `0` right up until it reports
tens of thousands of errors, so `0` alone tells you nothing about how much margin is
left. This probe injects N synthetic routes, re-syncs, and asserts the gate still
reads 0; if it does, there are at least N routes of room. It cleans up after itself
(the probe dir is gitignored, so an interrupted run can't leak routes into a commit).

There is no cheap proxy for the margin — don't try to replace this with a metric.
`Instantiations` from `tsgo --extendedDiagnostics` moved only 3% approaching the cliff
(4,494,539 → 4,641,569) and _drops_ past it (4,530,942) as the checker bails out early,
so it is non-monotonic and no threshold on it can work. Check time correlates but is
machine-dependent.

CI runs this as a separate `headroom` job in `typecheck.yml`, kept distinct from the
gate so "lost margin" is never confused with "real type error".

## If you see a flood of TS2859 "excessive complexity"

That is tsgo giving up on its global type-relation budget, not a real type error. It
also drags in thousands of bogus knock-on errors (TS2339/TS18046/TS2719/TS2345…) whose
messages look absurd — e.g. "two different types with this name exist" printing the
_same_ import path on both sides. None of those are trustworthy until the flood is gone.

Two things cause it, in this order of likelihood:

1. **A stale `.svelte-kit/`.** `svelte-kit sync` never prunes routes that were deleted
   or refactored away, so a long-lived working tree accumulates extra members in the
   generated `RouteId`/`Pathname` unions and tips over the budget while a fresh CI
   checkout is perfectly clean. **Always** `rm -rf .svelte-kit && npx svelte-kit sync`
   before believing a local count. (On 2026-07-28 exactly this — 3 stale route entries
   in a shared working tree — presented as "the gate is at ~40k errors on main" while
   the same commit was 0 in a fresh tree.)

2. **A generic instantiated over a route union with a dynamic string.** SvelteKit's
   `resolve()` is generic over `RouteIdWithSearchOrHash | PathnameWithSearchOrHash`,
   ~9k template-literal members at ~1450 routes. Find the hot site:

    ```bash
    node node_modules/@typescript/native/bin/tsc --noEmit \
        -p tsconfig/tsconfig.typecheck.src.json \
      | grep 'error TS2859' | sed 's/(.*//' | sort | uniq -c | sort -rn | head
    ```

    The top file is nearly always one call site. Narrow _that_ signature.

Do **not** respond by splitting the passes further, raising a threshold, adding a
baseline, or `@ts-expect-error`. Splitting cannot help: the expensive type lives in
`.svelte-kit/non-ambient.d.ts`, which every pass loads no matter how files are
partitioned — which is why both passes previously went over budget at the identical
point (+3 routes).

## History

The in-scope error count was driven from 1674 → 0 on 2026-07-23 (genuine fixes, no
suppressions). On 2026-07-28 the `resolve()` call site in `src/lib/paths.ts` was
narrowed: the gate had only **3 routes** of headroom before the complexity budget blew
(that one site produced 71k of 88k TS2859s), and now clears **>1500** added routes while
running ~3x faster. The two-pass split was kept as margin and was not load-bearing for
TS2859 — a single whole-project pass also measures 0. On 2026-11-03 the test pass was split
in two (server tests / the rest) and tsgo runs one checker, purely for MEMORY: GitHub's
2 vCPU / 8 GB runner killed the single test pass (see `runPass` in `tsgo-run.mjs`). This gate replaced an earlier
**tsc-baseline ratchet**
(`ratchet.mjs` + `baseline.json`, removed) that only caught _new_ errors versus a
frozen, platform-specific baseline — a workaround for when zero wasn't reachable.
With the count at zero, a hard-zero gate is simpler and stronger. See the
`no-working-typecheck-gate` project note for the full arc.
