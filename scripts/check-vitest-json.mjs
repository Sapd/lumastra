// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vitest JSON report guard + failing-file reporter.
 *
 * Was a heredoc duplicated into two jobs in .github/workflows/test.yml. It is a
 * file now for two reasons: the copies had already drifted (only one carried
 * `if: always()`), and a heredoc cannot be tested — this one has a unit suite
 * next to it.
 *
 * ── Half one: the zero-test guard (unchanged behaviour) ──
 *
 * A vitest run that collects ZERO tests is not automatically a CI failure. An
 * import-time throw during collection (e.g. a transitive import reaching
 * tasks/registry.ts, whose top-level read of a feature flag blows up a partial
 * `$lib/server/config` mock) has previously reported as "no tests" and exited 0.
 * A missing report file means the vitest step never ran at all. Both are failures
 * here, loudly, rather than silence that reads as success.
 *
 * ── Half two: say WHICH files failed ──
 *
 * The integration job writes this report and nothing ever read the failing half
 * of it. Its `continue-on-error: true` carries the comment "~9 pre-existing
 * failing files at pristine HEAD", and that number has not been re-measured since
 * it was written, because measuring it meant scrolling a ~37k-character log whose
 * tail is entirely Postgres container noise — the failing filenames sit above it,
 * and the report itself is never uploaded as an artifact.
 *
 * That is what keeps the job non-blocking: growing the ratchet in the sibling job
 * requires knowing which files are green, and nothing published that list. So on
 * a failing report this prints one line per failing file with its counts, to
 * stdout and to $GITHUB_STEP_SUMMARY, where it survives log retention and can be
 * diffed run over run.
 *
 * ── Half three: say WHICH TESTS, and why ──
 *
 * The file list alone sent the first reader who used it (2026-09-07) back to
 * guessing. Ten files were named; the run's actual cause was one fixture helper
 * whose derivation nine of them had copy-pasted, and nothing in a list of paths
 * could show that. The failure MESSAGES were in the log, but above the same 37k
 * window the file list was written to escape — only the last of 30 was legible.
 *
 * So each file now carries its failing test names and the first line of each
 * failure. That first line is where a shared cause shows itself: nine files
 * repeating one `expected 'u_d36e7a58' to be 'u_d36e7a58faa2…'` is a one-line
 * read, where nine paths are a morning.
 *
 * Capped (PER_FILE / TOTAL below) because the summary has a size limit and an
 * unbounded dump would be the log all over again.
 *
 * EXIT CODE IS DELIBERATELY UNCHANGED: 1 only for a missing report or a zero-test
 * collection. Failing TESTS are the vitest step's business to report — making
 * this script exit on them would silently convert the non-blocking integration
 * job into a blocking one through a step the job's continue-on-error comment does
 * not mention.
 *
 * Usage: node scripts/check-vitest-json.mjs <report.json> [more.json ...]
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { relative } from 'node:path';

/** Repo root, so absolute test paths print as `src/...` rather than `/home/runner/...`. */
const ROOT = process.cwd();

/** Failing tests listed per file, and across the whole report. Keeps the summary bounded. */
const PER_FILE = 10;
const TOTAL = 60;
/** One failure line; long enough for an `expected X to be Y` diff, short enough to scan. */
const REASON_CHARS = 200;

/**
 * First meaningful line of a vitest failure, stripped of ANSI and the stack.
 *
 * The message begins with the assertion (`AssertionError: expected … to be …`)
 * and continues into a stack that is noise here. Vitest colours the message, so
 * the escape codes have to go or the summary renders as literal `[32m`.
 */
function firstLine(failureMessages) {
    const raw = Array.isArray(failureMessages) ? (failureMessages[0] ?? '') : '';
    // eslint-disable-next-line no-control-regex -- stripping ANSI SGR is the point
    const clean = String(raw).replace(/\[[0-9;]*m/g, '');
    const line = clean
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
    if (!line) return '';
    return line.length > REASON_CHARS ? line.slice(0, REASON_CHARS - 1) + '…' : line;
}

/**
 * Reduce one vitest JSON report to the failing files and their counts.
 *
 * A file can fail two ways and both matter: individual assertions fail
 * (`assertionResults` carries them), or the file throws during collection, in
 * which case vitest marks the file failed with a `message` and NO assertion
 * results at all. Reporting only the first kind would hide exactly the
 * import-time throw the zero-test guard above exists to catch.
 *
 * @param {{testResults?: Array<{name?: string, status?: string, message?: string, assertionResults?: Array<{status?: string}>}>}} data
 * @returns {Array<{file: string, failed: number, total: number, collectionError: boolean,
 *                  tests: Array<{name: string, reason: string}>, reason: string}>}
 */
export function summarizeFailures(data) {
    const files = Array.isArray(data?.testResults) ? data.testResults : [];
    const out = [];

    for (const file of files) {
        const assertions = Array.isArray(file?.assertionResults) ? file.assertionResults : [];
        const failing = assertions.filter((a) => a?.status === 'failed');
        const failed = failing.length;
        const fileFailed = file?.status === 'failed';

        if (!fileFailed && failed === 0) continue;

        const name = file?.name ?? '(unknown file)';
        out.push({
            file: name.startsWith('/') ? relative(ROOT, name) : name,
            failed,
            total: assertions.length,
            // No failing assertion but the file is failed → it never got far
            // enough to run one.
            collectionError: fileFailed && failed === 0,
            tests: failing.map((a) => ({
                // `fullName` already joins the describe chain; fall back for
                // reporters that only emit the leaf title.
                name:
                    a?.fullName ||
                    [...(a?.ancestorTitles ?? []), a?.title].filter(Boolean).join(' › ') ||
                    '(unnamed test)',
                reason: firstLine(a?.failureMessages),
            })),
            // A collection error has no assertion to carry the cause, so the
            // file-level message is the only thing that says what threw.
            reason: fileFailed && failed === 0 ? firstLine([file?.message]) : '',
        });
    }

    // Worst first, so the top line is the one worth fixing next.
    out.sort((a, b) => b.failed - a.failed || a.file.localeCompare(b.file));
    return out;
}

/** Render the report lines for one file. Plain text; the caller decides where it goes. */
function renderReport(reportPath, data, failures) {
    const lines = [];
    lines.push(`### ${relative(ROOT, reportPath)}`);
    lines.push(
        `${data.numFailedTests ?? 0} failed / ${data.numTotalTests ?? 0} tests · ` +
            `${failures.length} failing file(s)`,
    );
    lines.push('');

    let budget = TOTAL;
    for (const f of failures) {
        lines.push(
            f.collectionError
                ? `- ${f.file} — FAILED DURING COLLECTION (no test ran)`
                : `- ${f.file} — ${f.failed}/${f.total} failed`,
        );

        if (f.collectionError) {
            if (f.reason) lines.push(`    ${f.reason}`);
            continue;
        }

        // Never print a file with no detail at all: if the budget is spent,
        // the counts above still stand and the tail line says what is missing.
        const shown = f.tests.slice(0, Math.max(0, Math.min(PER_FILE, budget)));
        budget -= shown.length;
        for (const t of shown) {
            lines.push(`    · ${t.name}`);
            if (t.reason) lines.push(`      ${t.reason}`);
        }
        const hidden = f.tests.length - shown.length;
        if (hidden > 0) lines.push(`    … and ${hidden} more failing test(s) in this file`);
    }
    return lines;
}

function main(argv) {
    const files = argv.slice(2);
    if (files.length === 0) {
        console.error('::error::check-vitest-json.mjs requires at least one report path');
        return 1;
    }

    let failed = false;
    const summary = [];

    for (const file of files) {
        if (!existsSync(file)) {
            console.error(`::error::Missing vitest JSON report: ${file}`);
            failed = true;
            continue;
        }

        const data = JSON.parse(readFileSync(file, 'utf8'));
        const total = data.numTotalTests ?? 0;
        console.log(`${file}: numTotalTests=${total} success=${data.success}`);

        if (total <= 0) {
            console.error(
                `::error::${file} reported ZERO collected tests. Per project ` +
                    `history this shape means an import-time throw during ` +
                    `collection, not an empty/skipped suite — failing the build.`,
            );
            failed = true;
            continue;
        }

        if (data.success === false) {
            const failures = summarizeFailures(data);
            const lines = renderReport(file, data, failures);
            // Not ::error:: — these are reported failures, not this script's
            // verdict, and annotating them would attribute them to this step.
            for (const line of lines) console.log(line);
            summary.push(...lines, '');
        }
    }

    // Best-effort: a summary that cannot be written must not fail a build over
    // reporting. Absent outside Actions, which is how the local tests run.
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath && summary.length > 0) {
        try {
            appendFileSync(summaryPath, ['## Failing test files', '', ...summary].join('\n'));
        } catch (err) {
            console.log(`(could not write GITHUB_STEP_SUMMARY: ${err.message})`);
        }
    }

    return failed ? 1 : 0;
}

// Only run when invoked directly, so the tests can import the helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    process.exit(main(process.argv));
}

export { main };
