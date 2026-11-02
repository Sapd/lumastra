// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Redaction + GitHub-issue formatting for Live TV stream failure events.
 *
 * Lives in $lib/shared — NOT in the Svelte page — so the copy button and these
 * tests execute the same code. Formatting logic inside a .svelte file is
 * unreachable from vitest and invisible to tsgo, so a redaction regression there
 * would ship green.
 *
 * Same two-pass discipline as the transcode report, and it REUSES that module's
 * `stripSecrets` / `redactPaths` rather than restating them — both operate on free
 * text and neither is tied to a transcode field:
 *   • stripSecrets — WRITE time (in the recorder). Protects the database.
 *   • redactPaths  — COPY time (here). Protects a public GitHub issue.
 *
 * The one thing Live TV needs that VOD does not is {@link redactUpstreamUrls}: an
 * IPTV source URL is the user's SUBSCRIPTION. Its credentials are already gone by
 * write time, but the provider host and the `/live/<subscriber>/` path segment are
 * identity in their own right and must not be pasted into a public issue.
 */
import { redactPaths, stripSecrets, type RedactOptions } from './transcode-failure-report.js';
import type {
    LiveTvFailureOutcome,
    LiveTvFailureSource,
} from '../../shared/livetv-failure-event.js';

/** Hosts that are the proxy talking to itself. Keeping these is diagnostically
 *  useful ("it failed reading its OWN playlist") and leaks nothing. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

/**
 * `scheme://…` up to the next whitespace or quote.
 *
 * `<` / `>` are deliberately allowed in the tail so this still matches a URL whose
 * userinfo `stripSecrets` has already rewritten to `<redacted>@` — stopping at the
 * angle bracket would leave the provider host standing.
 */
const URL_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\s'"]+)/g;

function authorityOf(rest: string): string {
    const afterUserinfo = rest.slice(rest.lastIndexOf('@') + 1);
    const end = afterUserinfo.search(/[/?#]/);
    const hostPort = end === -1 ? afterUserinfo : afterUserinfo.slice(0, end);
    // Strip the port; bracketed IPv6 literals keep their brackets stripped too.
    return hostPort.replace(/^\[|\]$/g, '').replace(/:\d+$/, '');
}

/**
 * Replace every non-loopback URL with `<scheme>://<redacted>`.
 *
 * The scheme is kept on purpose — "the source was plain http" or "it was rtsp" is a
 * real clue and carries no identity.
 */
export function redactUpstreamUrls(text: string): string {
    return text.replace(URL_RE, (match, scheme: string, rest: string) =>
        LOOPBACK_HOSTS.has(authorityOf(rest)) ? match : `${scheme}://<redacted>`,
    );
}

/**
 * `Failed to resolve hostname <host>: …` — the host WITHOUT a `scheme://` prefix.
 *
 * This is not a hypothetical shape: a DNS miss is the single most common IPTV
 * failure, and libavformat/tcp.c prints the bare host. {@link redactUpstreamUrls}
 * cannot see it (there is no scheme to anchor on), `stripSecrets` only knows
 * name=value / header / userinfo / JWT forms, and `redactPaths` only knows
 * filesystem roots — so without this pass the provider host, which IS the user's
 * subscription identity, reaches a public issue intact.
 *
 * Only this one anchored phrase is matched. A bare `host:port` has no reliable
 * shape to distinguish it from ordinary log text, and redacting on a guess would
 * eat the diagnostic content the report exists to carry.
 */
const RESOLVE_HOST_RE = /\b(resolve hostname\s+)([^\s:,'"]+)/gi;

export function redactBareHosts(text: string): string {
    return text.replace(RESOLVE_HOST_RE, (match, prefix: string, host: string) =>
        LOOPBACK_HOSTS.has(host) ? match : `${prefix}<redacted>`,
    );
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface LiveTvFailureReportInput {
    channelId: string;
    channelName: string | null;
    /** ISO-8601 timestamp as stored. */
    occurredAt: string;
    source: LiveTvFailureSource;
    outcome: LiveTvFailureOutcome;
    exitCode: number | null;
    signal: string | null;
    rungId: string | null;
    stderrTail: string;
    probe: Record<string, unknown> | null;
    decision: Record<string, unknown> | null;
    /** Typed failure reason (livetv-failure-reason.ts); absent on rows from before 16.402.0. */
    reason?: string | null;
    /** The feed that failed, when the proxy labelled the attempt. */
    feedId?: string | null;
    feedName?: string | null;
    /** Provider HTTP status, when the failure came from an HTTP answer. */
    upstreamStatus?: number | null;
    roots: RedactOptions;
}

function fence(lang: string, body: string): string {
    return `\`\`\`${lang}\n${body}\n\`\`\``;
}

/**
 * Render one Live TV failure as Markdown ready to paste into a GitHub issue.
 *
 * `github` mode strips credentials, upstream URLs, filesystem paths and the internal
 * channel id. `raw` keeps all of that for the operator's own use but STILL strips
 * credentials — they are removed at write time, so this is a defensive second layer
 * ensuring they can never reach any output.
 */
export function formatLiveTvFailureReport(
    input: LiveTvFailureReportInput,
    mode: 'github' | 'raw',
): string {
    // Segment paths are `<HLS_TEMP_DIR>/<channelId>/…` and HLS_TEMP_DIR is an env var
    // on the PROXY container, which the app can only guess at. When that guess is
    // wrong `redactPaths` matches nothing, so the channel id is stripped by name here
    // rather than left to the path rule — github mode promises to drop it.
    const channelIdRe =
        input.channelId.length > 0 ? new RegExp(escapeRe(input.channelId), 'g') : null;

    const sanitize = (text: string): string => {
        const noSecrets = stripSecrets(text);
        if (mode !== 'github') return noSecrets;
        const noHosts = redactBareHosts(redactUpstreamUrls(noSecrets));
        const noPaths = redactPaths(noHosts, input.roots);
        return channelIdRe ? noPaths.replace(channelIdRe, '<channel>') : noPaths;
    };

    const channel =
        input.channelName ??
        (mode === 'github' ? '(unnamed channel)' : `(unnamed channel ${input.channelId})`);

    const sections = [
        `### Live TV stream failure — \`${input.source}\``,
        '',
        `**Channel:** ${sanitize(channel)}`,
        ...(mode === 'github' ? [] : [`**Channel id:** \`${input.channelId}\``]),
        '',
        `| | |`,
        `|---|---|`,
        `| Occurred | \`${input.occurredAt}\` |`,
        `| Source | \`${input.source}\` |`,
        `| Outcome | \`${input.outcome}\` |`,
        ...(input.reason ? [`| Reason | \`${sanitize(input.reason)}\` |`] : []),
        ...(input.upstreamStatus ? [`| Provider HTTP status | \`${input.upstreamStatus}\` |`] : []),
        `| Exit code | \`${input.exitCode ?? 'n/a'}\` |`,
        `| Signal | \`${input.signal ?? 'n/a'}\` |`,
        `| Rung | \`${input.rungId ?? 'n/a'}\` |`,
        '',
        '**FFmpeg stderr**',
        fence('', sanitize(input.stderrTail || '(no stderr captured)')),
    ];

    if (input.probe) {
        sections.push(
            '',
            '**Source probe**',
            fence('json', sanitize(JSON.stringify(input.probe, null, 2))),
        );
    }

    if (input.decision) {
        sections.push(
            '',
            '**Transcode decision**',
            fence('json', sanitize(JSON.stringify(input.decision, null, 2))),
        );
    }

    return sections.join('\n');
}
