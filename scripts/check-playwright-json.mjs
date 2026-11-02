// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playwright JSON report → the two lists the e2e tier actually needs.
 *
 * ── Why this exists, concretely ──
 *
 * e2e.yml's first run (2026-09-07, run 1) did exactly what it was built to do:
 * it ran 49 specs on a Linux runner for the first time. Reading the outcome was
 * then impossible from here, in three independent ways:
 *
 *   - The HTML report is 16 MB and lives on a blob host the sandbox egress
 *     proxy refuses. Uploading it was right — it is not a way to READ a result.
 *   - The job log is ~285k characters, and the log reader returns the last ~37k.
 *     That window is entirely the Postgres service container's stderr, which
 *     GitHub appends after every step. The Playwright summary sits above it.
 *   - `continue-on-error: true` means the job's own red X says only "something
 *     failed", which was already known.
 *
 * This is the same blindness the integration tier had, and it gets the same
 * answer: the job reports itself, into $GITHUB_STEP_SUMMARY, which is neither
 * truncated from the wrong end nor hosted somewhere unreachable.
 *
 * ── The GREEN list is the point ──
 *
 * Gate 2c step two is an `e2e-ratchet` job over a named list of specs that are
 * known green, mirroring `integration-ratchet`. That list has to come from
 * somewhere, and "green" is a per-FILE property there: the ratchet runs whole
 * spec files, so a file with one flaky spec cannot join it.
 *
 * So the green list is printed first and is the primary output. The failing
 * list is secondary — useful, but it is not what unblocks the gate.
 *
 * ── Exit code ──
 *
 * 1 only for a missing or unparseable report, or a run that executed ZERO
 * specs. Failing specs exit 0, for the same reason as check-vitest-json.mjs:
 * the e2e job is non-blocking by design, and a guard that exits on failures
 * would silently make it blocking through a step whose continue-on-error
 * comment says nothing of the sort.
 *
 * Usage: node scripts/check-playwright-json.mjs <report.json>
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';

/** Caps, so a broadly-red run cannot reproduce the log this replaces. */
const PER_FILE = 8;
const TOTAL = 50;
const REASON_CHARS = 200;

/**
 * First meaningful line of a Playwright error, without ANSI or the stack.
 *
 * Playwright colours its diffs, and an un-stripped escape renders in the step
 * summary as a literal `[31m`.
 */
export function firstLine(message) {
    // eslint-disable-next-line no-control-regex -- stripping ANSI SGR is the point
    const clean = String(message ?? '').replace(/\[[0-9;]*m/g, '');
    const line = clean
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
    if (!line) return '';
    return line.length > REASON_CHARS ? line.slice(0, REASON_CHARS - 1) + '…' : line;
}

/**
 * Flatten Playwright's nested suites into one spec per entry.
 *
 * The shape is recursive — a file-level suite contains `describe` suites which
 * contain more — and `specs` can appear at every level, so anything that only
 * looks one deep silently misses every spec inside a `describe`.
 *
 * @param {{suites?: unknown[]}} node
 * @param {Array<{file: string, title: string, ok: boolean, skipped: boolean, error: string}>} out
 */
function walk(node, out) {
    for (const spec of Array.isArray(node?.specs) ? node.specs : []) {
        const tests = Array.isArray(spec?.tests) ? spec.tests : [];
        // A spec with every test skipped is neither green nor red: it proves
        // nothing, so it must not count as a ratchet candidate.
        const skipped = tests.length > 0 && tests.every((t) => t?.status === 'skipped');
        const results = tests.flatMap((t) => (Array.isArray(t?.results) ? t.results : []));
        const failing = results.find((r) => r?.status === 'failed' || r?.status === 'timedOut');
        // Slowest attempt, not the sum: a spec that was retried should report
        // how long it actually takes, not how long the retries took.
        const durationMs = results.reduce(
            (max, r) => Math.max(max, typeof r?.duration === 'number' ? r.duration : 0),
            0,
        );
        out.push({
            file: spec?.file ?? node?.file ?? '(unknown file)',
            title: spec?.title ?? '(unnamed spec)',
            ok: spec?.ok === true,
            skipped,
            durationMs,
            error: failing ? firstLine(failing?.error?.message ?? failing?.status) : '',
        });
    }
    for (const child of Array.isArray(node?.suites) ? node.suites : []) walk(child, out);
}

/**
 * Reduce a report to per-file verdicts.
 *
 * @returns {{green: Array<{file: string, count: number}>,
 *            red: Array<{file: string, failed: number, total: number,
 *                        specs: Array<{title: string, error: string}>}>,
 *            total: number}}
 */
export function summarize(data) {
    const specs = [];
    for (const suite of Array.isArray(data?.suites) ? data.suites : []) walk(suite, specs);

    const byFile = new Map();
    for (const s of specs) {
        if (!byFile.has(s.file)) byFile.set(s.file, []);
        byFile.get(s.file).push(s);
    }

    const green = [];
    const red = [];
    for (const [file, list] of byFile) {
        const failed = list.filter((s) => !s.ok && !s.skipped);
        const ran = list.filter((s) => !s.skipped);
        if (failed.length === 0) {
            // A file whose specs were ALL skipped proves nothing; it is not a
            // ratchet candidate, so it appears in neither list.
            if (ran.length > 0) {
                green.push({
                    file,
                    count: ran.length,
                    slowestMs: ran.reduce((max, s2) => Math.max(max, s2.durationMs ?? 0), 0),
                });
            }
        } else {
            red.push({
                file,
                failed: failed.length,
                total: ran.length,
                specs: failed.map((s) => ({ title: s.title, error: s.error })),
            });
        }
    }

    green.sort((a, b) => a.file.localeCompare(b.file));
    // Worst first: the top line is the one worth fixing next.
    red.sort((a, b) => b.failed - a.failed || a.file.localeCompare(b.file));
    return { green, red, total: specs.length };
}

/**
 * Render the report. Plain text; the caller decides where it goes.
 *
 * ── Why the GREEN list comes LAST ──
 *
 * It is the most important section, and that is exactly why it is at the
 * bottom. The first version led with it, which was right for a human reading
 * top-down and wrong for every other reader: the job log is only reachable
 * through its TAIL (~37k characters of ~285k), so leading with the green list
 * put the one section this script exists to produce in the part that gets
 * dropped. Run 2 proved it — the failing list was readable, the ratchet list
 * was not, from a script written to publish the ratchet list.
 *
 * So the order is: header, failing detail, then the green list and a repeat of
 * the counts as the final lines. The step summary reads fine either way; the
 * log only reads from the end.
 */
export function render({ green, red }) {
    const lines = [];
    const greenSpecs = green.reduce((n, f) => n + f.count, 0);
    const redSpecs = red.reduce((n, f) => n + f.failed, 0);
    const counts =
        `${green.length} green file(s) / ${red.length} failing file(s) · ` +
        `${greenSpecs} passed, ${redSpecs} failed`;

    lines.push(counts);
    lines.push('');

    lines.push('### Failing');
    lines.push('');
    if (red.length === 0) {
        lines.push('_(none)_');
    } else {
        let budget = TOTAL;
        for (const f of red) {
            lines.push(`- ${f.file} — ${f.failed}/${f.total} failed`);
            const shown = f.specs.slice(0, Math.max(0, Math.min(PER_FILE, budget)));
            budget -= shown.length;
            for (const s of shown) {
                lines.push(`    · ${s.title}`);
                if (s.error) lines.push(`      ${s.error}`);
            }
            const hidden = f.specs.length - shown.length;
            if (hidden > 0) lines.push(`    … and ${hidden} more failing spec(s) in this file`);
        }
    }
    lines.push('');

    // Last, so the log tail always carries it. See the note above.
    lines.push('### Green spec files — the e2e-ratchet candidate list');
    lines.push('');
    if (green.length === 0) {
        lines.push('_(none — nothing to ratchet yet)_');
    } else {
        // The slowest spec per file is printed because a PASSING duration is
        // evidence too. 00-hydration measures how long the client takes to
        // mount on a cold dev server, and that number decides whether the
        // failing specs are failing on budget or on behaviour — but a
        // console.log inside a test lands at the START of an eight-minute log,
        // which the ~37k-character tail can never reach. Here it survives.
        for (const f of green) {
            const slow = f.slowestMs ? ` · slowest ${(f.slowestMs / 1000).toFixed(1)}s` : '';
            lines.push(`- ${f.file} — ${f.count} spec(s)${slow}`);
        }
    }
    lines.push('');
    lines.push(counts);
    return lines;
}

function main(argv) {
    const file = argv[2];
    if (!file) {
        console.error('::error::check-playwright-json.mjs requires a report path');
        return 1;
    }
    if (!existsSync(file)) {
        console.error(`::error::Missing Playwright JSON report: ${file}`);
        return 1;
    }

    let data;
    try {
        data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
        console.error(`::error::Playwright JSON report is not parseable: ${err.message}`);
        return 1;
    }

    const summary = summarize(data);
    if (summary.total === 0) {
        console.error(
            `::error::${file} contains ZERO specs. The suite did not run — a config or ` +
                `webServer failure, not an empty test set.`,
        );
        return 1;
    }

    const lines = render(summary);
    for (const line of lines) console.log(line);

    // A `::notice::` as well as the log, because the log is not a reliable
    // channel here and this is the one line always worth reading.
    //
    // GitHub returns roughly the last 37k CHARACTERS of a job log, and appends
    // each service container's whole stderr AFTER the last step. In the e2e-ui
    // job that trailer — artifact upload, credential cleanup, and the Postgres
    // and Valkey dumps — fills the window by itself, so even output printed
    // last inside the last step can sit outside it. Printing the counts at the
    // end was already the second attempt at this and it still failed on run 17.
    //
    // Annotations are carried on the CHECK RUN rather than in the log body, so
    // they survive regardless of how much a container printed afterwards. One
    // line, counts plus the slowest spec per green file — 00-hydration's number
    // is what says whether the UI failures are cold-compile budget or real.
    const notice = [
        `${summary.green.length} green / ${summary.red.length} failing file(s)`,
        ...summary.green.map(
            (f) => `${f.file}${f.slowestMs ? ` ${(f.slowestMs / 1000).toFixed(1)}s` : ''}`,
        ),
    ].join(' · ');
    console.log(`::notice title=E2E spec summary::${notice}`);

    // Best-effort: a summary that cannot be written must not fail a build over
    // reporting. Absent outside Actions, which is how the local tests run.
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
        try {
            appendFileSync(summaryPath, ['## E2E specs', '', ...lines, ''].join('\n'));
        } catch (err) {
            console.log(`(could not write GITHUB_STEP_SUMMARY: ${err.message})`);
        }
    }

    return 0;
}

// Only run when invoked directly, so the tests can import the helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    process.exit(main(process.argv));
}

export { main };
