// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the Playwright report reducer.
 *
 * The load-bearing property is the GREEN list, because that list becomes the
 * `e2e-ratchet` job's spec list — a file wrongly called green makes a blocking
 * job red on its first run, which is precisely the failure mode e2e.yml was
 * staged to avoid. So the cases below are mostly about what must NOT reach it:
 * a file with one failure, and a file that only ever skipped.
 *
 * Run: npx vitest run scripts/check-playwright-json.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, summarize, render, firstLine } from './check-playwright-json.mjs';

let dir;

function report(name, data) {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(data));
    return p;
}

function run(file) {
    return main(['node', 'check-playwright-json.mjs', file]);
}

/** One spec, in the shape Playwright's JSON reporter emits. */
function spec(title, status, message, duration = 0) {
    return {
        title,
        ok: status === 'passed',
        tests: [
            { status, results: [{ status, duration, error: message ? { message } : undefined }] },
        ],
    };
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pw-json-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env.GITHUB_STEP_SUMMARY;
});

describe('the green list — what the ratchet is built from', () => {
    it('lists a file whose specs all passed', () => {
        const out = summarize({
            suites: [
                { file: 'a.ui.spec.ts', specs: [spec('one', 'passed'), spec('two', 'passed')] },
            ],
        });
        expect(out.green).toEqual([{ file: 'a.ui.spec.ts', count: 2, slowestMs: 0 }]);
        expect(out.red).toEqual([]);
    });

    it('excludes a file with even ONE failing spec', () => {
        // The ratchet runs whole files, so a single red spec disqualifies the
        // file — counting it green is how a blocking job goes red on day one.
        const out = summarize({
            suites: [
                {
                    file: 'a.ui.spec.ts',
                    specs: [spec('ok', 'passed'), spec('bad', 'failed', 'boom')],
                },
            ],
        });
        expect(out.green).toEqual([]);
        expect(out.red[0]).toMatchObject({ file: 'a.ui.spec.ts', failed: 1, total: 2 });
    });

    it('excludes a file that only ever skipped — it proves nothing', () => {
        const out = summarize({
            suites: [{ file: 'skipped.ui.spec.ts', specs: [spec('s', 'skipped')] }],
        });
        expect(out.green).toEqual([]);
        expect(out.red).toEqual([]);
    });

    it('counts a passing file by its RUN specs, ignoring skipped ones', () => {
        const out = summarize({
            suites: [
                {
                    file: 'a.ui.spec.ts',
                    specs: [spec('ran', 'passed'), spec('skipped', 'skipped')],
                },
            ],
        });
        expect(out.green).toEqual([{ file: 'a.ui.spec.ts', count: 1, slowestMs: 0 }]);
    });
});

describe('durations on the green list', () => {
    it('reports the SLOWEST spec in a green file, and renders it in seconds', () => {
        const out = summarize({
            suites: [
                {
                    file: 'a.ui.spec.ts',
                    specs: [
                        spec('fast', 'passed', undefined, 900),
                        spec('slow', 'passed', undefined, 24500),
                    ],
                },
            ],
        });

        expect(out.green).toEqual([{ file: 'a.ui.spec.ts', count: 2, slowestMs: 24500 }]);
        expect(render(out).join('\n')).toContain('slowest 24.5s');
    });

    it('takes the slowest ATTEMPT, not the sum, so a retried spec is not inflated', () => {
        const retried = {
            title: 'flaky',
            ok: true,
            tests: [
                {
                    status: 'passed',
                    results: [
                        { status: 'failed', duration: 30000 },
                        { status: 'passed', duration: 4000 },
                    ],
                },
            ],
        };

        // ok:true means the retry succeeded, so the file is green; the reported
        // number must be the 30s attempt, not 34s.
        const out = summarize({ suites: [{ file: 'a.ui.spec.ts', specs: [retried] }] });
        expect(out.green).toEqual([{ file: 'a.ui.spec.ts', count: 1, slowestMs: 30000 }]);
    });

    it('omits the duration when the report carries none', () => {
        const bare = {
            title: 'x',
            ok: true,
            tests: [{ status: 'passed', results: [{ status: 'passed' }] }],
        };
        const out = summarize({ suites: [{ file: 'a.ui.spec.ts', specs: [bare] }] });

        expect(out.green).toEqual([{ file: 'a.ui.spec.ts', count: 1, slowestMs: 0 }]);
        expect(render(out).join('\n')).not.toContain('slowest');
    });
});

describe('nesting and reasons', () => {
    it('finds specs inside describe blocks, not just at file level', () => {
        // Playwright nests a describe as a child suite. Walking one level deep
        // silently drops every spec inside one.
        const out = summarize({
            suites: [
                {
                    file: 'a.ui.spec.ts',
                    specs: [spec('top', 'passed')],
                    suites: [
                        {
                            file: 'a.ui.spec.ts',
                            specs: [spec('nested', 'passed')],
                            suites: [{ file: 'a.ui.spec.ts', specs: [spec('deeper', 'passed')] }],
                        },
                    ],
                },
            ],
        });
        expect(out.total).toBe(3);
        expect(out.green).toEqual([{ file: 'a.ui.spec.ts', count: 3, slowestMs: 0 }]);
    });

    it('carries the first error line and drops the stack', () => {
        const out = summarize({
            suites: [
                {
                    file: 'a.ui.spec.ts',
                    specs: [spec('bad', 'failed', 'Error: expected 1 to be 2\n  at foo.ts:3')],
                },
            ],
        });
        expect(out.red[0].specs[0]).toEqual({
            title: 'bad',
            error: 'Error: expected 1 to be 2',
        });
    });

    it('treats a timeout as a failure', () => {
        const out = summarize({
            suites: [{ file: 'a.ui.spec.ts', specs: [spec('slow', 'timedOut', 'Test timeout')] }],
        });
        expect(out.red[0].failed).toBe(1);
    });

    it('strips ANSI from the reason', () => {
        // ESC is built with String.fromCharCode rather than pasted as a raw
        // control byte: an invisible ESC in a source file is unreviewable, and
        // a test that loses it in transit asserts nothing. This exact case was
        // first written without one and passed a string the matcher never
        // touched — the regex correctly requires ESC, so bare "[31m" is text.
        const ESC = String.fromCharCode(27);
        expect(firstLine(`expected ${ESC}[31m'x'${ESC}[39m`)).toBe("expected 'x'");
    });
});

describe('rendering', () => {
    it('puts the green list LAST, where a tail-truncated log can reach it', () => {
        // Not cosmetic. Run 2 of e2e.yml led with the green list and the log
        // reader returns only the last ~37k of ~285k characters: the one
        // section this script exists to produce was the one that got dropped.
        const lines = render({
            green: [{ file: 'green.ui.spec.ts', count: 2 }],
            red: [
                {
                    file: 'red.ui.spec.ts',
                    failed: 1,
                    total: 1,
                    specs: [{ title: 't', error: 'e' }],
                },
            ],
        });
        const text = lines.join('\n');
        expect(text.indexOf('Green spec files')).toBeGreaterThan(text.indexOf('### Failing'));
        // …and the counts repeat at the very end, so a tail always has them.
        expect(lines[lines.length - 1]).toContain('1 green file(s)');
    });

    it('says so explicitly when nothing is green yet', () => {
        const lines = render({ green: [], red: [{ file: 'a', failed: 1, total: 1, specs: [] }] });
        expect(lines.join('\n')).toContain('nothing to ratchet yet');
    });

    it('caps the per-file spec list and states the remainder', () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ title: 't' + i, error: 'e' + i }));
        const lines = render({
            green: [],
            red: [{ file: 'a', failed: 12, total: 12, specs: many }],
        });
        const text = lines.join('\n');
        expect(text).toContain('t7');
        expect(text).not.toContain('t8');
        expect(text).toContain('… and 4 more failing spec(s) in this file');
    });
});

describe('exit code', () => {
    it('is 0 for a run with failures — the job is non-blocking by design', () => {
        // Load-bearing: exiting 1 here would make e2e.yml blocking through a
        // step whose continue-on-error comment says nothing of the sort.
        const p = report('red.json', {
            suites: [{ file: 'a.ui.spec.ts', specs: [spec('bad', 'failed', 'boom')] }],
        });
        expect(run(p)).toBe(0);
    });

    it('is 1 when the report is missing — the suite never ran', () => {
        expect(run(join(dir, 'nope.json'))).toBe(1);
    });

    it('is 1 for a report containing zero specs', () => {
        const p = report('empty.json', { suites: [] });
        expect(run(p)).toBe(1);
    });

    it('is 1 for an unparseable report rather than throwing', () => {
        const p = join(dir, 'bad.json');
        writeFileSync(p, '{not json');
        expect(run(p)).toBe(1);
    });

    it('is 1 when given no path at all', () => {
        expect(main(['node', 'check-playwright-json.mjs'])).toBe(1);
    });
});

describe('step summary', () => {
    it('writes the green list where log retention cannot truncate it', () => {
        const summaryPath = join(dir, 'summary.md');
        writeFileSync(summaryPath, '');
        process.env.GITHUB_STEP_SUMMARY = summaryPath;

        const p = report('mixed.json', {
            suites: [
                { file: 'green.ui.spec.ts', specs: [spec('a', 'passed')] },
                { file: 'red.ui.spec.ts', specs: [spec('b', 'failed', 'boom')] },
            ],
        });

        expect(run(p)).toBe(0);
        const written = readFileSync(summaryPath, 'utf8');
        expect(written).toContain('E2E specs');
        expect(written).toContain('green.ui.spec.ts');
        expect(written).toContain('red.ui.spec.ts');
        expect(written).toContain('boom');
    });

    it('does not fail the build when the summary cannot be written', () => {
        process.env.GITHUB_STEP_SUMMARY = join(dir, 'no-such-dir', 'summary.md');
        const p = report('ok.json', {
            suites: [{ file: 'a.ui.spec.ts', specs: [spec('a', 'passed')] }],
        });
        expect(run(p)).toBe(0);
    });
});
