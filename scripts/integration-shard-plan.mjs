// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Duration-balanced sharding for the integration suite.
 *
 * Vitest's `--shard=i/N` splits by file COUNT. Integration files run one after the other in
 * each shard (`fileParallelism: false`, one database per shard), and their durations range
 * from 0.1 s to 220 s, so count-based shards finished 954 s .. 1226 s apart on a 4-shard run.
 * This plan assigns files by measured duration (longest first, always into the currently
 * lightest shard), which is deterministic: every shard computes the same plan from the same
 * tree and prints only its own files.
 *
 *   node scripts/integration-shard-plan.mjs <index> <total>        # this shard's files, one per line
 *   node scripts/integration-shard-plan.mjs --stats <total>        # per-shard estimate (planning aid)
 *   node scripts/integration-shard-plan.mjs --from-logs <dir>...   # new timings JSON on stdout
 *
 * The candidate list comes from Vitest's own include/exclude for vitest.integration.config.ts,
 * so a new integration file is picked up without touching this script, and no file can be
 * left out: the plan is a partition of that list. Timings live in
 * tests/integration/shard-timings.json (files missing from it cost `defaultSeconds`).
 * `--from-logs` reads the per-shard logs of a run (the `✓ file (N tests) 1234ms` lines of the
 * default reporter, e.g. the shard-*.log files lumastra-remote keeps) and averages them.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMINGS_PATH = 'tests/integration/shard-timings.json';

/**
 * Longest-processing-time-first partition. Pure and deterministic.
 * @param {string[]} files candidate files (any order)
 * @param {{defaultSeconds?: number, perFileOverheadSeconds?: number, files?: Record<string, number>}} timings
 * @param {number} total number of shards
 * @returns {{plan: string[][], load: number[]}} files per shard (sorted by path), estimated seconds per shard
 */
export function planShards(files, timings, total) {
    if (!Number.isInteger(total) || total < 1) throw new Error(`invalid shard total: ${total}`);
    const known = timings?.files ?? {};
    const base = timings?.defaultSeconds ?? 1;
    const overhead = timings?.perFileOverheadSeconds ?? 0;
    const cost = (f) => (known[f] ?? base) + overhead;
    const unique = [...new Set(files)];
    const order = unique.sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
    const load = new Array(total).fill(0);
    const plan = Array.from({ length: total }, () => []);
    for (const f of order) {
        let best = 0;
        for (let i = 1; i < total; i++) if (load[i] < load[best]) best = i;
        plan[best].push(f);
        load[best] += cost(f);
    }
    for (const p of plan) p.sort();
    return { plan, load };
}

// eslint-disable-next-line no-control-regex -- strips colour codes from reporter output
const ANSI = /\x1b\[[0-9;]*m/g;
const RESULT = /^\s*(?:\[[^\]]*\]\s+)?[✓❯×]\s+(\S+\.test\.ts)\s+\((\d+) tests?[^)]*\)\s*(\d+)ms/;

/**
 * Average per-file test seconds over any number of reporter logs.
 * @param {string[]} logTexts
 * @returns {Record<string, number>}
 */
export function timingsFromLogs(logTexts) {
    const samples = new Map();
    for (const text of logTexts) {
        for (const raw of text.split('\n')) {
            const m = RESULT.exec(raw.replace(ANSI, ''));
            if (!m) continue;
            if (!samples.has(m[1])) samples.set(m[1], []);
            samples.get(m[1]).push(Number(m[3]) / 1000);
        }
    }
    const out = {};
    for (const [file, xs] of [...samples].sort(([a], [b]) => (a < b ? -1 : 1))) {
        out[file] = Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
    }
    return out;
}

async function candidateFiles(root) {
    const { createVitest } = await import('vitest/node');
    const ctx = await createVitest('test', {
        config: 'vitest.integration.config.ts',
        watch: false,
    });
    try {
        return (await ctx.globTestSpecifications()).map((s) => relative(root, s.moduleId));
    } finally {
        await ctx.close();
    }
}

function loadTimings(root) {
    try {
        return JSON.parse(readFileSync(join(root, TIMINGS_PATH), 'utf8'));
    } catch (error) {
        // A missing/unreadable file must degrade to an even-by-count plan, never to no plan.
        console.error(
            `[shard-plan] no usable ${TIMINGS_PATH} (${error.message}); balancing by file count`,
        );
        return {};
    }
}

function logFiles(paths) {
    const found = [];
    const walk = (p) => {
        let entries;
        try {
            entries = readdirSync(p, { withFileTypes: true });
        } catch {
            found.push(p);
            return;
        }
        for (const e of entries) {
            if (e.isDirectory()) walk(join(p, e.name));
            else if (/\.log$/.test(e.name)) found.push(join(p, e.name));
        }
    };
    paths.forEach(walk);
    return found;
}

async function main(argv) {
    const root = process.cwd();
    if (argv[0] === '--from-logs') {
        const logs = logFiles(argv.slice(1));
        if (!logs.length) throw new Error('--from-logs needs at least one log file or directory');
        const files = timingsFromLogs(logs.map((f) => readFileSync(f, 'utf8')));
        const previous = loadTimings(root);
        const keep = Object.fromEntries(Object.entries(files).filter(([, s]) => s >= 2));
        console.log(
            JSON.stringify(
                {
                    version: 1,
                    comment: previous.comment,
                    defaultSeconds: previous.defaultSeconds ?? 1,
                    perFileOverheadSeconds: previous.perFileOverheadSeconds ?? 1.5,
                    files: keep,
                },
                null,
                1,
            ),
        );
        return;
    }
    const stats = argv[0] === '--stats';
    const index = stats ? 0 : Number(argv[0]);
    const total = Number(stats ? argv[1] : argv[1]);
    if (
        !Number.isInteger(total) ||
        total < 1 ||
        (!stats && (!Number.isInteger(index) || index < 1 || index > total))
    ) {
        throw new Error(
            'usage: integration-shard-plan.mjs <index 1..total> <total> | --stats <total> | --from-logs <dir>...',
        );
    }
    const files = await candidateFiles(root);
    if (!files.length) throw new Error('Vitest found no integration test files');
    const { plan, load } = planShards(files, loadTimings(root), total);
    if (stats) {
        plan.forEach((p, i) =>
            console.log(`shard ${i + 1}/${total}: ${p.length} files, ~${Math.round(load[i])} s`),
        );
        return;
    }
    for (const f of plan[index - 1]) console.log(f);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch((error) => {
        console.error(`[shard-plan] ${error.message}`);
        process.exit(1);
    });
}
