// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Redaction + GitHub-issue formatting for a single task run.
 *
 * Sibling of `transcode-failure-report.ts` and deliberately built the same way:
 * a PURE function in $lib/shared, never inside the .svelte panel. Formatting
 * logic in a component is unreachable from vitest and invisible to tsgo, so a
 * redaction regression there ships green.
 *
 * The credential and path passes are NOT re-implemented here — they are
 * `stripSecrets` / `redactPaths` from `transcode-failure-report.ts`, which are
 * generic regex-over-text and not tied to transcode fields. Only the field
 * layout below is domain-specific.
 *
 * Mode semantics match the transcode report exactly:
 *   • `github` — strips credentials AND redacts library/transcode paths and the
 *                scope user id. Safe to paste into a public issue.
 *   • `raw`    — keeps paths and identity for the operator's own debugging, but
 *                still strips credentials (they must never reach any output).
 *
 * NOTE on stack traces: application source frames (e.g.
 * `/app/build/server/chunks/runner.js`) are deliberately KEPT in github mode —
 * they are the entire diagnostic value of a stack and reveal nothing about the
 * operator's library. Only paths under a configured media library root or the
 * transcode working directory are identity, and those are redacted.
 */

import {
    stripSecrets,
    redactPaths,
    redactSecretKeys,
    type RedactOptions,
} from './transcode-failure-report.js';

export type { RedactOptions };

export interface TaskRunReportInput {
    runId: string;
    taskId: string;
    /** Human-readable run label as shown in the admin UI. */
    label?: string;
    state: string;
    /** `run.trigger.kind` — scheduled / manual / webhook / in-process … */
    trigger: string;
    startedAt: string;
    completedAt?: string;
    ownerInstanceId?: string;
    scope?: { libraryGroupId?: string; userId?: string };
    /** `task_history.error` — carries `stack` only on admin-gated responses. */
    error?: { message: string; kind?: string; stack?: string } | null;
    /** `task_history.input` — the args that produced this run. */
    input?: unknown;
    roots: RedactOptions;
}

function fence(lang: string, body: string): string {
    return `\`\`\`${lang}\n${body}\n\`\`\``;
}

/** Render a task run as Markdown ready to paste into a GitHub issue. */
export function formatTaskRunReport(input: TaskRunReportInput, mode: 'github' | 'raw'): string {
    // Two passes, in this order: credentials always, paths only for github.
    // `unquoted: true` — every text source here (DB error message, V8 stack
    // frame, JSON.stringify output) is free text, not ffmpeg's quoted
    // `Opening '…'` shape, so a path containing an apostrophe must not
    // truncate the match early and leak its remainder.
    const sanitize = (text: string): string => {
        const noSecrets = stripSecrets(text);
        return mode === 'github'
            ? redactPaths(noSecrets, { ...input.roots, unquoted: true })
            : noSecrets;
    };

    let inputBlock: string;
    if (input.input === undefined || input.input === null) {
        inputBlock = '(no input)';
    } else {
        try {
            // Key-aware pass FIRST, in both modes. `sanitize` alone cannot see a
            // credential inside serialized JSON: `"token": "abc"` matches
            // neither the `name=value` query shape nor the unquoted `name: value`
            // header shape `stripSecrets` handles. Shipping tasks carry only
            // structural identifiers, but a plugin's `.passthrough()` input can
            // carry anything — and that is the case this report must survive.
            const serialized = JSON.stringify(redactSecretKeys(input.input), null, 2);
            inputBlock = serialized === undefined ? '(no input)' : sanitize(serialized);
        } catch {
            // Circular reference / BigInt. The orchestrator rejects these at
            // enqueue time, but a report renderer must never throw on the data
            // it was handed.
            inputBlock = '(input not serializable)';
        }
    }

    const err = input.error ?? null;

    const rows: string[] = [
        `| Run id | \`${input.runId}\` |`,
        `| Task id | \`${input.taskId}\` |`,
        `| State | \`${input.state}\` |`,
        `| Trigger | \`${input.trigger}\` |`,
        `| Started | \`${input.startedAt}\` |`,
    ];
    if (input.completedAt) rows.push(`| Completed | \`${input.completedAt}\` |`);
    if (input.ownerInstanceId) rows.push(`| Owner instance | \`${input.ownerInstanceId}\` |`);
    if (input.scope?.libraryGroupId) {
        rows.push(`| Library group | \`${input.scope.libraryGroupId}\` |`);
    }
    // The scope user id is identity, not diagnostics — dropped in github mode,
    // same rule the transcode report applies to username/IP.
    if (mode === 'raw' && input.scope?.userId) {
        rows.push(`| Scope user | \`${input.scope.userId}\` |`);
    }

    const sections = [
        `### Task run failure — \`${input.taskId}\``,
        '',
        `**Run:** ${input.label ? sanitize(input.label) : input.runId}`,
        '',
        `| | |`,
        `|---|---|`,
        ...rows,
        '',
        '**Error**',
        fence('', err ? sanitize(err.message) : '(no error recorded)'),
        '',
        `**Error kind:** \`${err?.kind ?? 'n/a'}\``,
        '',
        '**Stack**',
        fence('', err?.stack ? sanitize(err.stack) : '(stack not captured)'),
        '',
        '**Input**',
        fence('json', inputBlock),
    ];

    return sections.join('\n');
}
