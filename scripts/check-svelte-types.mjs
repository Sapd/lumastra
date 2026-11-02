#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Svelte type-check gate + shrink-only quarantine ratchet.
 *
 * WHY THIS EXISTS
 * ---------------
 * `npm run check` runs `svelte-check-native`, a fast reimplementation that
 * reports zero problems for `.svelte` files. `npm run typecheck` runs tsgo,
 * which skips `.svelte` by design. The net effect, measured on 2026-08-27:
 * planting
 *
 *     const __typeCheckProbe: number = "definitely a string";
 *
 * in a component's `<script lang="ts">` produced `COMPLETED 2026 FILES
 * 0 ERRORS 0 WARNINGS` from `npm run check` and exit code 0, while
 * `npm run typecheck` was also clean. NOTHING in the standard workflow
 * type-checked a Svelte component, across all 746 of them.
 *
 * The official `svelte-check` is already a devDependency and does work, but
 * needs headroom: without a raised heap it dies with
 * `FATAL ERROR: Ineffective mark-compacts near heap limit`. 8 GB stopped being
 * enough on 2026-10-13 (the stable gate's check hit the limit), so it is 12 GB. That OOM is the
 * likely reason the tool was swapped — the swap traded the guarantee away
 * silently instead of raising the heap. `npm test` already uses the same
 * flag, so the pattern was established.
 *
 * What the hole cost, concretely: four `getErrorMessage(e)` calls in
 * `src/routes/admin/library/media/+page.svelte` were missing the REQUIRED
 * second `fallback` argument. Every one of the same function's `.ts` callers
 * passes two, because tsgo enforces it there. In the component the arity
 * error was invisible, so an admin whose delete/unlock/image-sync failed with
 * a non-Error rejection got a BLANK toast.
 *
 * WHY A RATCHET AND NOT A PLAIN GATE
 * ----------------------------------
 * Turning the official checker on wholesale would put main permanently red
 * over a pre-existing backlog, which teaches people to ignore the check —
 * the exact mistake this repo made with its integration tier. So the backlog
 * is QUARANTINED per file with an expected error COUNT, and the gate is
 * blocking for everything else.
 *
 * The count is what makes this a ratchet rather than an amnesty list:
 *   - actual > expected  -> a REGRESSION in a quarantined file. Fails.
 *   - actual < expected  -> progress. Fails, demanding the number be lowered.
 *   - actual === 0       -> the file graduated. Fails, demanding removal.
 * The number can therefore only ever move DOWN, and an entry can only ever
 * leave the list. Same shape as `scripts/check-lint-tiers.mjs` (a drift guard
 * that fails when two halves disagree) and the integration ratchet in
 * `.github/workflows/test.yml`.
 *
 * WARNINGS are now BLOCKING too, because the count is zero. The six on the
 * original baseline were all the same CSS-compat note (`Also define the
 * standard property 'line-clamp'`) and were fixed outright, so gating them
 * costs nothing today and stops the category growing back — the same reason
 * `lint` runs at `--max-warnings=0`. A warning that cannot be fixed should be
 * argued about in review, not parked in a list; there is deliberately no
 * warning quarantine.
 *
 * Note svelte-check only lints PLAIN `<style>` blocks: `<style lang="postcss">`
 * and standalone `.css` files are invisible to it. The baseline said 6 while
 * 11 sites actually had the defect.
 *
 * Run: `npm run check:svelte-types` (~90s). Wired as a blocking CI job.
 */

import { spawnSync } from 'node:child_process';

/**
 * Files allowed to still have `.svelte` type errors, with the exact count each
 * is allowed and a one-line reason. LOWER a number when you fix something;
 * DELETE the entry when it reaches zero. Never raise a number to make a build
 * green — that is the failure this file exists to prevent.
 *
 * Drained 2026-08-27: the admin-media TDZ (12), the LiveSessionSection /
 * ActiveStreamsSection `clientname` mismatch (2), the PipelineTimeline
 * narrowing (1) and the MovieCalendar series-id namespace mixup (1) are all
 * FIXED. The list is EMPTY, which is the state it was built to reach — an
 * empty object is correct, not a missing config. It is also closed to new
 * entries: a new `.svelte` type error is a failure to fix, not a candidate
 * for quarantine.
 */
const QUARANTINE = {};

const SVELTE_CHECK_ARGS = ['svelte-check', '--tsconfig', './tsconfig.json', '--output', 'machine'];

// `--output machine` emits one record per line:
//   <epoch> ERROR "<relative path>" <line>:<col> "<message>"
// Paths and messages are double-quoted with backslash escapes (messages carry
// literal \n for multi-line diagnostics), hence the escape-aware groups.
const RECORD = /^\d+\s+(ERROR|WARNING)\s+"((?:[^"\\]|\\.)*)"\s+(\d+):(\d+)\s+"((?:[^"\\]|\\.)*)"/;

function run() {
    const result = spawnSync('npx', SVELTE_CHECK_ARGS, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
            ...process.env,
            // Without this the checker OOMs on this codebase. See header.
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=12288`.trim(),
        },
    });

    if (result.error) {
        console.error(`svelte-check failed to start: ${result.error.message}`);
        process.exit(2);
    }

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    // A crashed or truncated run must never be read as "no errors". The
    // COMPLETED record is the checker's own statement that it finished.
    if (!/^\d+\s+COMPLETED\s/m.test(output)) {
        console.error('svelte-check did not emit a COMPLETED record — treating as a failure.');
        console.error(output.slice(-4000));
        process.exit(2);
    }

    return output;
}

function parse(output) {
    const errorsByFile = new Map();
    const warnings = [];

    for (const line of output.split('\n')) {
        const match = RECORD.exec(line.trim());
        if (!match) continue;
        const [, severity, file, ln, col, message] = match;
        if (severity === 'WARNING') {
            warnings.push({ file, ln, col, message });
            continue;
        }
        if (!errorsByFile.has(file)) errorsByFile.set(file, []);
        errorsByFile.get(file).push({ ln, col, message });
    }

    return { errorsByFile, warnings };
}

const output = run();
const { errorsByFile, warnings } = parse(output);

const failures = [];

// 1. Any error in a file that is NOT quarantined is a hard failure. This is
//    the gate: new type errors in components cannot land.
for (const [file, errors] of errorsByFile) {
    if (file in QUARANTINE) continue;
    for (const e of errors) {
        failures.push(`  ${file}:${e.ln}:${e.col}\n      ${e.message.replace(/\\n/g, '\n      ')}`);
    }
}

if (failures.length > 0) {
    console.error(`\n${failures.length} Svelte type error(s) in non-quarantined files:\n`);
    console.error(failures.join('\n'));
    console.error(
        '\nFix them. Do NOT add the file to QUARANTINE in scripts/check-svelte-types.mjs —' +
            '\nthat list is closed to new entries and exists only to be drained.',
    );
}

// 2. Ratchet: a quarantined file that improved must have its number lowered
//    (or the entry deleted). This is what stops the list from rotting.
const ratchet = [];
for (const [file, expected] of Object.entries(QUARANTINE)) {
    const actual = errorsByFile.get(file)?.length ?? 0;
    if (actual === expected) continue;
    if (actual > expected) {
        ratchet.push(
            `  ${file}: REGRESSED — expected at most ${expected} error(s), found ${actual}.`,
        );
    } else if (actual === 0) {
        ratchet.push(
            `  ${file}: now CLEAN — delete its entry from QUARANTINE in scripts/check-svelte-types.mjs.`,
        );
    } else {
        ratchet.push(
            `  ${file}: improved to ${actual} error(s) — lower its QUARANTINE number from ${expected} to ${actual}.`,
        );
    }
}

if (ratchet.length > 0) {
    console.error(`\nQuarantine ratchet (scripts/check-svelte-types.mjs):\n`);
    console.error(ratchet.join('\n'));
}

// 3. Warnings are blocking, with no quarantine — see the header. The count was
//    driven to zero, so any warning here is one this change introduced.
if (warnings.length > 0) {
    console.error(
        `\n${warnings.length} Svelte warning(s) — the warning count must stay at zero:\n`,
    );
    for (const w of warnings) {
        console.error(
            `  ${w.file}:${w.ln}:${w.col}\n      ${w.message.replace(/\\n/g, '\n      ')}`,
        );
    }
}

const quarantinedTotal = Object.entries(QUARANTINE).reduce(
    (sum, [file]) => sum + (errorsByFile.get(file)?.length ?? 0),
    0,
);

console.log(
    `\nsvelte-check: ${quarantinedTotal} quarantined error(s) across ` +
        `${Object.keys(QUARANTINE).length} file(s), ${warnings.length} warning(s) (gated).`,
);

if (failures.length > 0 || ratchet.length > 0 || warnings.length > 0) process.exit(1);

console.log('No Svelte type errors outside the quarantine, and the quarantine is exact.');
