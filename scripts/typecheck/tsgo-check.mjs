// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * tsgo-check.mjs — the repo's real typecheck gate.
 *
 * Runs `tsgo` (TypeScript 7, the Go-native compiler) which type-checks the full
 * SvelteKit project WITHOUT the OOM that plagues `tsc` here (~15s, ~4GB, no crash).
 * The in-scope error count was driven to ZERO on 2026-07-23, so this replaces the
 * old tsc-baseline ratchet: instead of "no NEW errors vs a frozen, platform-specific
 * baseline", the contract is simply "zero type errors, full stop".
 *
 * Why tsgo and not tsc/svelte-check:
 *   - `tsc --noEmit` OOMs without an 8GB heap and takes minutes.
 *   - `vite build` only transpiles — it never type-checks.
 *   - `svelte-check` is separately broken on this toolchain (Node 25 / TS6 crash).
 * See scripts/typecheck/README.md and the `no-working-typecheck-gate` note.
 *
 * REQUIRES `svelte-kit sync` first — tsconfig.json extends the gitignored
 * .svelte-kit/tsconfig.json, so without a sync tsgo sees a broken config.
 *
 * Modes:
 *   default            → blocking: exit 1 if any error.
 *   TYPECHECK_REPORT_ONLY=1 → always exit 0, just print the count (used while the
 *                             gate is being trusted / to read the CI-side count).
 *
 * The tsgo version is PINNED — it is a preview build; letting `npx` float to
 * "latest" would let a new preview silently change the error set under CI.
 */
import { CONFIGS, runPass } from './tsgo-run.mjs';

/*
 * THREE-PASS split — source, server tests and all other tests are checked as separate
 * programs. Coverage is complete either way: every source file is checked in the src
 * pass, every test file in exactly one test pass, and source imported by a test is
 * checked there too. The tests are split in two for MEMORY only (see
 * tsconfig/tsconfig.typecheck.test-server.json and runPass in tsgo-run.mjs).
 *
 * WHAT THE SPLIT IS *NOT* FOR (corrected 2026-07-28 — the earlier note here was
 * wrong and cost a day of debugging):
 *
 * When tsgo blows its global type-relation budget it emits floods of TS2859
 * "excessive complexity" errors plus thousands of bogus second-order errors
 * (TS2339/TS18046/TS2719/…) that are NOT real type errors. Splitting the file set
 * does NOT fix that, because the dominant cost lives in `.svelte-kit/non-ambient.d.ts`
 * — the generated `$app/types` module — which EVERY pass loads regardless of how the
 * files are partitioned. Measured: src and test passes went over budget at the exact
 * same point (+3 routes), precisely because the split cannot shrink that shared type.
 *
 * The real driver is call sites that instantiate SvelteKit's route-typed generics
 * against a *dynamic* string. `resolve()` is generic over
 * `RouteIdWithSearchOrHash | PathnameWithSearchOrHash` (~9k template-literal members
 * at ~1450 routes); ONE such call in src/lib/paths.ts accounted for 71k of 88k TS2859s
 * and left the gate only 3 routes from breaking. Narrowing that one signature restored
 * headroom from +3 to >+1500 routes and made the gate ~3x faster.
 *
 * So: if TS2859 ever reappears, DO NOT split further (it cannot help) and DO NOT raise or ignore the
 * count. Instead find the hot call site — run a pass, then group TS2859 by file:
 *   npx -y -p <pinned tsgo> tsgo --noEmit -p tsconfig/tsconfig.typecheck.src.json \
 *     | grep 'error TS2859' | cut -d'(' -f1 | sort | uniq -c | sort -rn | head
 * The top entry is almost always a single generic instantiated over a route union.
 *
 * NOTE also: a STALE `.svelte-kit/` fakes this failure. `svelte-kit sync` does not
 * prune deleted routes, so a long-lived working tree can accumulate extra entries in
 * the RouteId/Pathname unions and go over budget while a fresh checkout is clean.
 * Always `rm -rf .svelte-kit && npx svelte-kit sync` before trusting a local count.
 */
const errors = [];
for (const cfg of CONFIGS) {
    const { errors: passErrors, launchError } = runPass(cfg.file);
    if (launchError) {
        console.error(`tsgo failed to launch (${cfg.label}): ${launchError}`);
        process.exit(2);
    }
    console.log(`tsgo pass '${cfg.label}' (${cfg.file}): ${passErrors.length} error(s)`);
    errors.push(...passErrors);
}

const count = errors.length;

console.log(`tsgo type errors (in scope): ${count}`);
if (count > 0) {
    console.log('\n--- errors ---');
    console.log(errors.slice(0, 300).join('\n'));
    if (errors.length > 300) console.log(`… and ${errors.length - 300} more`);
}

const reportOnly = process.env.TYPECHECK_REPORT_ONLY === '1';

if (reportOnly) {
    console.log(
        count === 0 ? '\n✓ typecheck clean' : `\n(report-only) ${count} error(s) — not failing.`,
    );
    process.exit(0);
}

if (count > 0) {
    console.error(
        `\n✖ Typecheck failed: ${count} type error(s). The build is blocked until these are fixed.`,
    );
    process.exit(1);
}

console.log('\n✓ typecheck clean — zero type errors.');
process.exit(0);
