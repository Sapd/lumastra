// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GitHub-issue-ready formatter for a single item's plugin failure timeline
 * (`plugin_failure_events`, surfaced via
 * `GET /api/v1/tasks/{taskId}/failures/{itemId}/history`).
 * The itemId identifies the failed item, not a failure-event row.
 *
 * Lives in $lib/shared — NOT in a .svelte file — for the same reason as
 * transcode-failure-report.ts: formatting logic inside a component is
 * unreachable from vitest and invisible to tsgo, so a redaction regression
 * there would ship green.
 *
 * Path redaction happens server-side (`buildFailureHistory` in
 * defs/tasks/[taskId]/failures/[itemId]/history.ts) — the configured library roots
 * never reach the client, so this formatter cannot redo it here. `reason` is
 * therefore already clean of absolute media paths by the time it arrives;
 * `stripSecrets` is applied again anyway as a cheap, roots-free defensive
 * layer (it needs no server-side knowledge to run).
 */

import { stripSecrets } from './transcode-failure-report.js';
import { escapeTablePipes } from './markdown-table-cell.js';

export interface FailureTimelineEventInput {
    reason?: string;
    occurredAt: string | Date;
}

function formatTimestamp(val: string | Date): string {
    const d = typeof val === 'string' ? new Date(val) : val;
    return isNaN(d.getTime()) ? String(val) : d.toISOString();
}

/** Escape a value for a single Markdown table cell: a literal `|` would
 *  split into extra columns, and a raw newline (sidecar tracebacks are a
 *  known source — see the sonic-embedder case this feature was built for)
 *  would terminate the table early and dump every following row as literal
 *  text. */
function escapeTableCell(text: string): string {
    return escapeTablePipes(text).replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * Render a single item's failure timeline as Markdown ready to paste into a
 * GitHub issue: plugin id, item id, then each (occurred_at, reason) pair.
 *
 * Events are rendered in the order given — the caller (the history endpoint)
 * is responsible for chronological (oldest-first) ordering; this function
 * does not re-sort.
 */
export function formatFailureTimelineForGithub(
    pluginId: string,
    itemId: string,
    events: FailureTimelineEventInput[],
    truncated = false,
): string {
    const sanitize = (text: string): string => escapeTableCell(stripSecrets(text));

    const lines = [`### Failure history — \`${pluginId}\` / \`${itemId}\``, ''];

    if (truncated) {
        lines.push(
            '> ⚠️ Showing the 200 most recent events — older attempts (including the ' +
                'first failure) were dropped.',
            '',
        );
    }

    if (events.length === 0) {
        lines.push('_No recorded failures._');
        return lines.join('\n');
    }

    lines.push('| Occurred | Reason |', '|---|---|');
    for (const event of events) {
        const reason = event.reason ? sanitize(event.reason) : '_(no reason recorded)_';
        lines.push(`| ${formatTimestamp(event.occurredAt)} | ${reason} |`);
    }

    return lines.join('\n');
}
