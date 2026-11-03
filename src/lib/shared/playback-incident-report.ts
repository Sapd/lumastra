// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Redaction + GitHub-issue formatting for playback incidents, mirroring
 * transcode-failure-report.ts's two-mode structure. Unlike that report, this
 * one has structured IDENTITY COLUMNS (userId, deviceId, clientInfo) the
 * transcode report never had to handle — github mode DROPS them entirely
 * (not just redacts free text), the same way formatFailureReport already
 * drops username/ipAddress only in its own github mode via conditional
 * appending, generalized here to a fixed set of always-excluded fields.
 */

import { escapeTablePipes } from './markdown-table-cell.js';
import {
    stripSecrets,
    redactPaths,
    redactSecretKeys,
    type RedactOptions,
} from './transcode-failure-report.js';
import type {
    PlaybackIncidentDetail,
    PlaybackIncidentSummary,
    CorrelatedTranscodeFailure,
} from '$lib/schemas/api-playback-incidents.js';

/**
 * Neutralize a run of 3+ backticks inside text that will be embedded in a
 * ``` markdown code fence — without this, a timeline value that happens to
 * contain a triple-backtick run prematurely closes the fence and corrupts
 * every section that follows it in the generated report.
 */
function escapeFence(text: string): string {
    return text.replace(/`{3,}/g, (run) => run.split('').join('​'));
}

export function formatIncidentReport(
    incident: PlaybackIncidentDetail,
    mode: 'github' | 'raw',
    roots: RedactOptions,
    correlatedTranscodeFailures: CorrelatedTranscodeFailure[] = [],
): string {
    // Every text source here (client-reported message/timeline/clientInfo, and
    // the errorType/stage/reconnectCause free-text fields below) is unquoted
    // free text, not ffmpeg's quoted `Opening '…'` diagnostic shape — pass
    // `unquoted: true` or a real path containing an apostrophe (common in
    // media titles, e.g. "Guns N' Roses") truncates the redaction match at
    // the apostrophe and leaks the remainder of the path in github mode.
    const sanitizeText = (t: string): string => {
        const noSecrets = stripSecrets(t);
        return mode === 'github' ? redactPaths(noSecrets, { ...roots, unquoted: true }) : noSecrets;
    };

    const redactedTimeline = redactSecretKeys(incident.timeline) as Record<string, unknown>[];
    const timelineBlock =
        redactedTimeline.length === 0
            ? '(no timeline recorded)'
            : redactedTimeline
                  .map((entry) => JSON.stringify(entry))
                  .map(sanitizeText)
                  .map(escapeFence)
                  .join('\n');

    const sections = [
        `### Playback incident — \`${incident.triggerType}\``,
        '',
        `- **Incident at**: ${incident.incidentAt}`,
        `- **Error type**: ${incident.errorType ? sanitizeText(incident.errorType) : '(none)'}`,
        `- **Stage**: ${incident.stage ? sanitizeText(incident.stage) : '(none)'}`,
        `- **HTTP status**: ${incident.httpStatus ?? '(none)'}`,
        `- **Server diagnostic code**: ${incident.serverDiagnosticCode ?? '(none)'}`,
        `- **Reconnect cause**: ${incident.reconnectCause ? sanitizeText(incident.reconnectCause) : '(none)'}`,
        `- **Resolved**: ${incident.resolvedAt ? 'yes, at ' + incident.resolvedAt : 'no'}`,
    ];

    if (incident.message) {
        sections.push('', '**Message**', sanitizeText(incident.message));
    }

    if (mode === 'raw') {
        sections.push(
            '',
            '**Identity** (raw mode only)',
            `- attemptId: ${incident.attemptId}`,
            `- playSessionId: ${incident.playSessionId}`,
            `- userId: ${incident.userId ?? '(none)'}`,
            `- deviceId: ${incident.deviceId ?? '(none)'}`,
            `- mediaId: ${incident.mediaId ?? '(none)'}`,
        );
        if (incident.clientInfo) {
            sections.push('', '**Client info**', sanitizeText(JSON.stringify(incident.clientInfo)));
        }
    }

    sections.push('', '**Timeline**', '```', timelineBlock, '```');

    if (correlatedTranscodeFailures.length > 0) {
        sections.push('', '**Related transcode failures**');
        for (const failure of correlatedTranscodeFailures) {
            const summary = failure.summary ? `: ${sanitizeText(failure.summary)}` : '';
            sections.push(`- ${failure.occurredAt} — \`${failure.category}\`${summary}`);
        }
    }

    return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Page-level export: the incident table, or one opened incident
// ---------------------------------------------------------------------------

/** Flatten to one line and neutralize the column separator so a noisy value
 *  cannot shred the Markdown table it lives in. */
function tableCell(text: string): string {
    return escapeTablePipes(text.replace(/\s*[\r\n]+\s*/g, ' '));
}

/**
 * `clientInfo` keys that describe the CLIENT rather than the person: what
 * the web player sends (`playMethod`) plus the neutral platform/codec names a
 * native client may add. Everything else in `clientInfo` — `userAgent`
 * included, which github mode has always dropped — stays out.
 */
const CLIENT_INFO_PUBLIC_KEYS = [
    'playMethod',
    'platform',
    'appVersion',
    'osVersion',
    'player',
    'container',
    'videoCodec',
    'audioCodec',
] as const;

export interface PlaybackIncidentsReportInput {
    /** The rows currently on screen. */
    incidents: PlaybackIncidentSummary[];
    /** True when the page is filtered to one user, so the copy says so. */
    userFiltered?: boolean;
    /** The incident whose drawer is open, when one is. */
    selected?: {
        incident: PlaybackIncidentDetail;
        correlatedTranscodeFailures: CorrelatedTranscodeFailure[];
    } | null;
    roots: RedactOptions;
}

/**
 * Render the playback-incidents PAGE for a GitHub issue: the visible rows, or
 * — when a drawer is open — that incident via {@link formatIncidentReport} in
 * github mode, followed by the non-identifying client fields the drawer's own
 * button leaves out.
 *
 * github mode only. User, device and media names/ids never appear; every
 * free-text column runs through the same credential + path redaction as the
 * single-incident report.
 */
export function formatPlaybackIncidentsReport(input: PlaybackIncidentsReportInput): string {
    const clean = (t: string): string =>
        redactPaths(stripSecrets(t), { ...input.roots, unquoted: true });
    const banner = `_Copied from Admin → Users → Playback incidents${
        input.userFiltered ? ' (filtered to one user)' : ''
    }. Credentials and filesystem paths are redacted and user, device and media identity omitted — intended to be pasted into a public issue._`;

    const selected = input.selected ?? null;
    if (selected !== null) {
        const lines = [
            formatIncidentReport(
                selected.incident,
                'github',
                input.roots,
                selected.correlatedTranscodeFailures,
            ),
            '',
            banner,
        ];
        const info = selected.incident.clientInfo;
        if (info) {
            const rows = CLIENT_INFO_PUBLIC_KEYS.filter(
                (key) => typeof info[key] === 'string' || typeof info[key] === 'number',
            ).map((key) => `- **${key}**: ${clean(String(info[key]))}`);
            if (rows.length > 0) {
                lines.push('', '**Client** (non-identifying fields only)', ...rows);
            }
        }
        return lines.join('\n');
    }

    const n = input.incidents.length;
    const lines = [`### Playback incidents (${n} row${n === 1 ? '' : 's'})`, '', banner, ''];
    if (n === 0) {
        lines.push('_No incidents recorded._');
        return lines.join('\n');
    }
    lines.push(
        '| Occurred | Trigger | Error type | Stage | HTTP | Server code | Reconnect cause | Resolved |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...input.incidents.map(
            (i) =>
                `| ${tableCell(i.incidentAt)} | \`${i.triggerType}\` | ${
                    i.errorType ? tableCell(clean(i.errorType)) : '—'
                } | ${i.stage ? tableCell(clean(i.stage)) : '—'} | ${i.httpStatus ?? '—'} | ${
                    i.serverDiagnosticCode ? `\`${tableCell(i.serverDiagnosticCode)}\`` : '—'
                } | ${i.reconnectCause ? tableCell(clean(i.reconnectCause)) : '—'} | ${
                    i.resolvedAt ? 'yes' : 'no'
                } |`,
        ),
    );
    return lines.join('\n');
}
