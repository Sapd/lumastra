#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * resolve-narrowing-probe.mjs — is the `resolveDynamic` cast still load-bearing?
 *
 * `src/lib/paths.ts` calls SvelteKit's `resolve()` through
 *
 *     const resolveDynamic = resolve as unknown as (path: string) => string;
 *
 * because `resolve()` is generic over `RouteIdWithSearchOrHash |
 * PathnameWithSearchOrHash` — every route id AND pathname in the app, ×3 for the
 * search/hash variants. Inferring that for a *dynamic* string is astronomically
 * expensive and blew tsgo's global type-relation budget.
 *
 * That cast has two costs. It discards `resolve()`'s route type-checking, and it
 * is the reason `svelte/no-navigation-without-resolve` cannot be used (it only
 * recognises `resolve` imported straight from `$app/paths`), which is why this
 * repo carries the bespoke `callback-safety/require-base-aware-navigation`
 * instead. Both are worth paying only while the constraint is real.
 *
 * A comment cannot tell you when that stops being true — a TypeScript, tsgo or
 * SvelteKit upgrade could fix it silently. This script measures it:
 *
 *   1. Snapshot src/lib/paths.ts.
 *   2. Replace the cast with a genuinely typed call.
 *   3. Run the `src` typecheck pass and count errors.
 *   4. Restore the file, ALWAYS (including on failure/^C).
 *
 * Measured 2026-07-28: 4 errors with the cast, 43,665 without it (282 of them
 * TS2859). If this ever reports numbers close to each other, the workaround —
 * and the bespoke lint rule that exists because of it — can be retired.
 *
 * Deliberately NOT part of `npm run typecheck`: it costs a full extra pass and
 * is a periodic question, not a per-commit gate.
 *
 * Usage: npm run typecheck:resolve-probe
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET = resolvePath(ROOT, 'src/lib/paths.ts');

const CAST = 'const resolveDynamic = resolve as unknown as (path: string) => string;';
const TYPED =
    'const resolveDynamic = (path: string): string =>\n' +
    '    resolve(path as Parameters<typeof resolve>[0]);';

/** Run the src typecheck pass and return its in-scope error count. */
function countErrors() {
    let out;
    try {
        out = execFileSync('node', ['scripts/typecheck/tsgo-check.mjs'], {
            cwd: ROOT,
            encoding: 'utf-8',
            env: { ...process.env, TYPECHECK_REPORT_ONLY: '1' },
            maxBuffer: 256 * 1024 * 1024,
        });
    } catch (err) {
        // Non-zero exit is expected when errors exist; the count is still printed.
        out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    const m = out.match(/tsgo type errors \(in scope\):\s*(\d+)/);
    const ts2859 = (out.match(/TS2859/g) ?? []).length;
    return { total: m ? Number(m[1]) : NaN, ts2859 };
}

const original = readFileSync(TARGET, 'utf-8');
if (!original.includes(CAST)) {
    console.error(
        `resolve-probe: the narrowing cast is no longer present in ${TARGET}.\n` +
            'Either it was already removed (great — delete this probe and revisit\n' +
            'svelte/no-navigation-without-resolve) or it was reworded, in which case\n' +
            'update CAST in this script.',
    );
    process.exit(2);
}

// The incremental build info caches the POISONED state, so a later run can
// report the probe's error count long after the file is restored. Clearing it
// on both sides is what makes this script safe to run.
function clearIncremental() {
    for (const f of [
        'tsconfig.typecheck.src.tsbuildinfo',
        'tsconfig.typecheck.test-server.tsbuildinfo',
        'tsconfig.typecheck.test-rest.tsbuildinfo',
    ]) {
        try {
            execFileSync('rm', ['-f', f], { cwd: ROOT });
        } catch {
            /* best effort */
        }
    }
}

let restored = false;
function restore() {
    if (restored) return;
    restored = true;
    writeFileSync(TARGET, original);
    clearIncremental();
}
process.on('exit', restore);
process.on('SIGINT', () => {
    restore();
    process.exit(130);
});

clearIncremental();
console.log('resolve-probe: baseline (cast in place) …');
const baseline = countErrors();

writeFileSync(TARGET, original.replace(CAST, TYPED));
clearIncremental();
console.log('resolve-probe: without the cast …');
const probed = countErrors();

restore();

console.log('');
console.log(`  with cast:    ${baseline.total} errors`);
console.log(`  without cast: ${probed.total} errors (${probed.ts2859} × TS2859)`);
console.log('');

if (Number.isNaN(baseline.total) || Number.isNaN(probed.total)) {
    console.error('resolve-probe: could not parse an error count — check tsgo-check.mjs output.');
    process.exit(2);
}

if (probed.total <= baseline.total) {
    console.log(
        'resolve-probe: THE WORKAROUND IS NO LONGER NEEDED.\n' +
            '  - drop `resolveDynamic` in src/lib/paths.ts and call resolve() directly\n' +
            '  - re-enable svelte/no-navigation-without-resolve in eslint.config.cjs\n' +
            '  - retire callback-safety/require-base-aware-navigation (GUARD H)',
    );
    process.exit(1);
}

console.log(
    `resolve-probe: still load-bearing (+${probed.total - baseline.total} errors without it). ` +
        'Keep the cast and GUARD H.',
);
