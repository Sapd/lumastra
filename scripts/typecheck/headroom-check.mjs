// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * headroom-check.mjs — early warning for tsgo's type-relation budget.
 *
 * WHY THIS EXISTS
 *
 * The budget failure is a CLIFF, not a ramp. `npm run typecheck` reporting 0 tells
 * you nothing about how close you are: on 2026-07-28 the gate read a clean 0 while
 * sitting THREE routes from collapse — adding 3 routes produced 1,276 errors, 10
 * produced 27,615, 25 produced 161,201. Past the cliff tsgo emits TS2859 "excessive
 * complexity" floods plus thousands of bogus knock-on errors, so the gate goes from
 * "green" to "unreadable" with no warning in between.
 *
 * There is no cheap proxy for the margin. Measured on this repo:
 *   - `Instantiations` (tsgo --extendedDiagnostics) is USELESS: it moved only 3%
 *     (4,494,539 → 4,641,569) approaching the cliff, and it DROPS past it
 *     (4,530,942) because the checker bails out early. Non-monotonic, so no
 *     threshold on it can work.
 *   - Check time correlates (3.7s healthy vs 12.9s near the cliff) but is
 *     machine-dependent and noisy.
 *
 * So this measures the margin directly: inject N synthetic routes, re-sync, and
 * assert the gate still reads 0. If it does, there are at least N routes of room.
 *
 * The probe writes into src/routes/, so it ALWAYS cleans up (including on
 * SIGINT/SIGTERM) and the probe directory is gitignored — an interrupted run must
 * never leave routes behind that another session could commit.
 *
 * Usage:
 *   node scripts/typecheck/headroom-check.mjs           # default 250 routes
 *   node scripts/typecheck/headroom-check.mjs --routes 500
 *
 * Exit codes: 0 = headroom OK, 1 = headroom exhausted, 2 = tooling failure.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { CONFIGS, runPass } from './tsgo-run.mjs';

/** Gitignored (see .gitignore) so a crashed run can never leak routes into a commit. */
const PROBE_DIR = path.join('src', 'routes', '__typecheck_probe__');

const routesArgIndex = process.argv.indexOf('--routes');
const ROUTE_COUNT =
    routesArgIndex !== -1 ? Number.parseInt(process.argv[routesArgIndex + 1], 10) : 250;

if (!Number.isInteger(ROUTE_COUNT) || ROUTE_COUNT < 1) {
    console.error(`Invalid --routes value: ${process.argv[routesArgIndex + 1]}`);
    process.exit(2);
}

function cleanup() {
    rmSync(PROBE_DIR, { recursive: true, force: true });
}

/** Re-sync so the tree is left exactly as we found it, probe routes gone. */
function sync() {
    const res = spawnSync('npx', ['svelte-kit', 'sync'], { encoding: 'utf8' });
    return res.status === 0 && !res.error;
}

let interrupted = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        interrupted = true;
        cleanup();
        sync();
        process.exit(2);
    });
}

/** Left undefined until a branch decides; `?? 2` at exit makes the default FAILURE. */
let exitCode;
try {
    // A previous crashed run may have left probes behind; start from a known state.
    cleanup();

    console.log(`probing with +${ROUTE_COUNT} synthetic routes...`);
    for (let i = 1; i <= ROUTE_COUNT; i++) {
        const dir = path.join(PROBE_DIR, `r${i}`);
        mkdirSync(dir, { recursive: true });
        // A minimal endpoint is enough: what costs is the route's membership in the
        // generated RouteId/Pathname unions, not the handler body.
        writeFileSync(
            path.join(dir, '+server.ts'),
            'export function GET(): Response {\n    return new Response("probe");\n}\n',
        );
    }

    if (!sync()) {
        console.error('svelte-kit sync failed while setting up the probe.');
        process.exit(2);
    }

    let total = 0;
    let launchFailed = false;
    for (const cfg of CONFIGS) {
        const { errors, launchError } = runPass(cfg.file);
        if (launchError) {
            console.error(`tsgo failed to launch (${cfg.label}): ${launchError}`);
            launchFailed = true;
            break;
        }
        console.log(`  ${cfg.label} pass: ${errors.length} error(s)`);
        total += errors.length;
        if (errors.length > 0) {
            const complexity = errors.filter((l) => /error TS2859/.test(l));
            // Group the flood by file — the top entry is almost always the single
            // generic that needs narrowing.
            const byFile = new Map();
            for (const line of complexity) {
                const file = line.split('(')[0].trim();
                byFile.set(file, (byFile.get(file) ?? 0) + 1);
            }
            const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
            if (top.length > 0) {
                console.log(`    TS2859: ${complexity.length}, worst offenders:`);
                for (const [file, n] of top)
                    console.log(`      ${n.toString().padStart(7)}  ${file}`);
            }
        }
    }

    if (launchFailed) {
        exitCode = 2;
    } else if (total === 0) {
        console.log(`\n✓ headroom OK — at least ${ROUTE_COUNT} routes of margin.`);
        exitCode = 0;
    } else {
        console.error(
            `\n✖ headroom exhausted: +${ROUTE_COUNT} routes already produces ${total} error(s).\n` +
                `  The gate is close to collapsing, even if it currently reads 0.\n\n` +
                `  Do NOT split the passes further, raise a threshold, add a baseline, or\n` +
                `  @ts-expect-error — none of those address this. Splitting cannot help: the\n` +
                `  expensive type is the generated $app/types in .svelte-kit/non-ambient.d.ts,\n` +
                `  which every pass loads regardless of how files are partitioned.\n\n` +
                `  Fix the worst offender above — it is nearly always ONE generic being\n` +
                `  instantiated over a route union with a dynamic string (see the resolve()\n` +
                `  note in src/lib/paths.ts). scripts/typecheck/README.md has the full recipe.`,
        );
        exitCode = 1;
    }
} finally {
    if (!interrupted) {
        cleanup();
        if (!sync()) {
            console.error(
                'WARNING: svelte-kit sync failed during cleanup. Run `npx svelte-kit sync` before trusting a local typecheck.',
            );
        }
        if (existsSync(PROBE_DIR)) {
            console.error(`WARNING: probe directory still present at ${PROBE_DIR} — remove it.`);
        }
    }
}

// `?? 2` so an unforeseen path can never exit 0 and fake a pass.
process.exit(exitCode ?? 2);
