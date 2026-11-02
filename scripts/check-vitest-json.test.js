// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the vitest JSON report guard.
 *
 * The point of the file existing at all: this logic previously lived as a
 * heredoc inside .github/workflows/test.yml, where nothing could exercise it —
 * and it had already gone wrong once in production. On run 33063152602 the
 * report path was under /tmp, which persists between jobs on the self-hosted
 * runner, so a SKIPPED vitest step left the guard reading the PREVIOUS run's
 * file and reporting `numTotalTests=5530 success=false` as a pass: a green guard
 * over a suite that never executed. The workflow fix was runner.temp; the reason
 * nobody caught it earlier is that a heredoc has no tests.
 *
 * Run: npx vitest run scripts/check-vitest-json.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, summarizeFailures } from './check-vitest-json.mjs';

let dir;

/** Write a report file and hand back its path. */
function report(name, data) {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(data));
    return p;
}

/** main() reads argv positionally, mirroring `node script.mjs <files...>`. */
function run(...files) {
    return main(['node', 'check-vitest-json.mjs', ...files]);
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vitest-json-guard-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env.GITHUB_STEP_SUMMARY;
});

describe('exit code — unchanged from the heredoc it replaces', () => {
    it('passes a successful report', () => {
        const p = report('ok.json', { numTotalTests: 12, success: true, testResults: [] });
        expect(run(p)).toBe(0);
    });

    it('fails when the report is missing — the skipped-step case', () => {
        expect(run(join(dir, 'nope.json'))).toBe(1);
    });

    it('fails on a zero-test collection', () => {
        const p = report('empty.json', { numTotalTests: 0, success: true, testResults: [] });
        expect(run(p)).toBe(1);
    });

    it('does NOT fail merely because tests failed', () => {
        // Load-bearing: the integration job is non-blocking by design. If this
        // returned 1 the guard would quietly make it blocking through a step
        // whose continue-on-error comment says nothing of the sort.
        const p = report('red.json', {
            numTotalTests: 10,
            numFailedTests: 3,
            success: false,
            testResults: [
                {
                    name: '/repo/src/a.integration.test.ts',
                    status: 'failed',
                    assertionResults: [{ status: 'failed' }, { status: 'passed' }],
                },
            ],
        });
        expect(run(p)).toBe(0);
    });

    it('fails once when several reports are bad', () => {
        const ok = report('ok.json', { numTotalTests: 3, success: true, testResults: [] });
        const empty = report('empty.json', { numTotalTests: 0, success: true, testResults: [] });
        expect(run(ok, empty)).toBe(1);
    });

    it('fails when given no arguments at all', () => {
        expect(run()).toBe(1);
    });
});

describe('summarizeFailures', () => {
    it('reports per-file failed and total counts', () => {
        const out = summarizeFailures({
            testResults: [
                {
                    name: 'a.test.ts',
                    status: 'failed',
                    assertionResults: [{ status: 'failed' }, { status: 'passed' }],
                },
                {
                    name: 'b.test.ts',
                    status: 'passed',
                    assertionResults: [{ status: 'passed' }],
                },
            ],
        });
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ file: 'a.test.ts', failed: 1, total: 2 });
    });

    it('flags a file that threw during collection', () => {
        // The shape the zero-test guard exists for: file failed, no assertion
        // ever ran. Counting only failed assertions would report it as clean.
        const out = summarizeFailures({
            testResults: [
                {
                    name: 'boom.test.ts',
                    status: 'failed',
                    message: 'import threw',
                    assertionResults: [],
                },
            ],
        });
        expect(out).toHaveLength(1);
        expect(out[0].collectionError).toBe(true);
        expect(out[0].failed).toBe(0);
    });

    it('sorts worst first', () => {
        const out = summarizeFailures({
            testResults: [
                { name: 'few.test.ts', status: 'failed', assertionResults: [{ status: 'failed' }] },
                {
                    name: 'many.test.ts',
                    status: 'failed',
                    assertionResults: [
                        { status: 'failed' },
                        { status: 'failed' },
                        { status: 'failed' },
                    ],
                },
            ],
        });
        expect(out.map((f) => f.file)).toEqual(['many.test.ts', 'few.test.ts']);
    });

    it('tolerates a report with no testResults', () => {
        expect(summarizeFailures({})).toEqual([]);
    });
});

describe('failing test names and reasons', () => {
    /** Build a failing assertion the way vitest's JSON reporter emits one. */
    const failing = (title, message) => ({
        status: 'failed',
        fullName: `Group > ${title}`,
        ancestorTitles: ['Group'],
        title,
        failureMessages: message ? [message] : [],
    });

    it('carries each failing test name and its first message line', () => {
        const [file] = summarizeFailures({
            testResults: [
                {
                    name: 'src/a.test.ts',
                    status: 'failed',
                    assertionResults: [
                        failing(
                            'exposes the handle',
                            "AssertionError: expected 'a' to be 'b'\n  at foo:1:1",
                        ),
                        { status: 'passed' },
                    ],
                },
            ],
        });

        expect(file.tests).toHaveLength(1);
        expect(file.tests[0].name).toBe('Group > exposes the handle');
        // The stack must not come along — it is what made the log unreadable.
        expect(file.tests[0].reason).toBe("AssertionError: expected 'a' to be 'b'");
    });

    it('strips ANSI colour so the summary is not full of escape codes', () => {
        const [file] = summarizeFailures({
            testResults: [
                {
                    name: 'src/a.test.ts',
                    status: 'failed',
                    assertionResults: [failing('t', "expected [32m'x'[39m to be 'y'")],
                },
            ],
        });
        expect(file.tests[0].reason).toBe("expected 'x' to be 'y'");
    });

    it('falls back to the describe chain when fullName is absent', () => {
        const [file] = summarizeFailures({
            testResults: [
                {
                    name: 'src/a.test.ts',
                    status: 'failed',
                    assertionResults: [
                        { status: 'failed', ancestorTitles: ['Outer', 'Inner'], title: 'leaf' },
                    ],
                },
            ],
        });
        expect(file.tests[0].name).toBe('Outer › Inner › leaf');
    });

    it('takes the cause from the file message for a collection error', () => {
        const [file] = summarizeFailures({
            testResults: [
                {
                    name: 'src/boom.test.ts',
                    status: 'failed',
                    message: 'TypeError: m.foo is not a function\n  at adapters.ts:703',
                    assertionResults: [],
                },
            ],
        });
        expect(file.collectionError).toBe(true);
        expect(file.reason).toBe('TypeError: m.foo is not a function');
    });

    it('caps the per-file list and says how many it withheld', () => {
        const summaryPath = join(dir, 'summary.md');
        writeFileSync(summaryPath, '');
        process.env.GITHUB_STEP_SUMMARY = summaryPath;

        const many = Array.from({ length: 14 }, (_, i) => failing(`case ${i}`, `boom ${i}`));
        const p = report('red.json', {
            numTotalTests: 14,
            numFailedTests: 14,
            success: false,
            testResults: [{ name: 'src/many.test.ts', status: 'failed', assertionResults: many }],
        });

        expect(run(p)).toBe(0);
        const written = readFileSync(summaryPath, 'utf8');
        expect(written).toContain('case 9');
        expect(written).not.toContain('case 10');
        expect(written).toContain('… and 4 more failing test(s) in this file');
    });
});

describe('step summary', () => {
    it('writes the failing files when GITHUB_STEP_SUMMARY is set', () => {
        const summaryPath = join(dir, 'summary.md');
        writeFileSync(summaryPath, '');
        process.env.GITHUB_STEP_SUMMARY = summaryPath;

        const p = report('red.json', {
            numTotalTests: 5,
            numFailedTests: 2,
            success: false,
            testResults: [
                {
                    name: 'src/x.integration.test.ts',
                    status: 'failed',
                    assertionResults: [{ status: 'failed' }, { status: 'failed' }],
                },
            ],
        });

        expect(run(p)).toBe(0);
        const written = readFileSync(summaryPath, 'utf8');
        expect(written).toContain('Failing test files');
        expect(written).toContain('src/x.integration.test.ts');
        expect(written).toContain('2/2 failed');
    });

    it('writes nothing for a green report', () => {
        const summaryPath = join(dir, 'summary.md');
        writeFileSync(summaryPath, '');
        process.env.GITHUB_STEP_SUMMARY = summaryPath;

        const p = report('ok.json', { numTotalTests: 4, success: true, testResults: [] });
        expect(run(p)).toBe(0);
        expect(readFileSync(summaryPath, 'utf8')).toBe('');
    });

    it('does not fail the build when the summary file cannot be written', () => {
        process.env.GITHUB_STEP_SUMMARY = join(dir, 'no-such-dir', 'summary.md');
        const p = report('red.json', {
            numTotalTests: 2,
            numFailedTests: 1,
            success: false,
            testResults: [
                { name: 'a.test.ts', status: 'failed', assertionResults: [{ status: 'failed' }] },
            ],
        });
        expect(run(p)).toBe(0);
    });
});
