// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Data assembly for the Failures tab on Settings → Live TV.
 *
 * Sits beside `livetv-proxy-data.ts` (the Proxy tab) because a stream failure is
 * the same subject an operator is already looking at when a channel is dead —
 * this is deliberately NOT a separate admin route.
 *
 * Draining before reading is what makes the tab feel live: the proxy pushes onto
 * Valkey and the background drain runs on a 60s timer, so a failure that happened
 * ten seconds ago would otherwise be invisible on the page that exists to report it.
 */
import { getDb } from '$lib/server/database/connection.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { listLiveTvFailureEvents } from '$lib/server/database/queries/livetv-failure-events.queries.js';
import { drainLiveTvFailureEvents } from '$lib/server/services/livetv/livetv-failure-drain.js';
import type { RedactOptions } from '$lib/shared/transcode-failure-report.js';
import type { LiveTvFailureReportInput } from '$lib/shared/livetv-failure-report.js';

/**
 * Rows are up to ~8KB each (stderr + probe + decision), and every one of them is
 * carried whole because the copy button needs the full record — a light list plus a
 * per-row fetch would be a second API surface for no diagnostic gain at this size.
 */
const FAILURE_LIST_LIMIT = 30;

/**
 * Where the proxy writes its HLS segments — same expression as
 * `ffmpeg-manager.ts`, so a deployment that sets `HLS_TEMP_DIR` on both services
 * (the usual compose shape) gets its real root redacted instead of the default.
 *
 * This is still a guess: the app cannot read the PROXY container's environment, so
 * a split configuration falls back to the default and matches nothing. That is why
 * `formatLiveTvFailureReport` strips the channel id by name in github mode rather
 * than trusting this root to hide it inside `<root>/<channelId>/…`.
 */
const LIVETV_SEGMENT_ROOT = process.env.HLS_TEMP_DIR || '/tmp/lumastra-live';

/** One incident, plus everything the pure formatter needs to redact it. */
export type LiveTvFailureIncident = Omit<LiveTvFailureReportInput, 'roots'> & { id: string };

export interface LiveTvFailuresTabData {
    incidents: LiveTvFailureIncident[];
    roots: RedactOptions;
    /** Set when the incident list could not be read (never shown as "no failures"). */
    loadError?: string;
}

export async function loadLiveTvFailuresTabData(): Promise<LiveTvFailuresTabData> {
    const sql = getDb();
    if (!sql) {
        return { incidents: [], roots: { libraryRoots: [], transcodeRoot: LIVETV_SEGMENT_ROOT } };
    }

    await drainLiveTvFailureEvents();

    const [rows, libraryPaths] = await Promise.all([
        listLiveTvFailureEvents(sql, FAILURE_LIST_LIMIT),
        getEnabledLibraryPaths(sql),
    ]);

    return {
        incidents: rows.map((row) => ({
            id: row.id,
            channelId: row.channel_id,
            channelName: row.channel_name,
            occurredAt: row.occurred_at.toISOString(),
            source: row.source,
            outcome: row.outcome,
            exitCode: row.exit_code,
            signal: row.signal,
            rungId: row.rung_id,
            stderrTail: row.stderr_tail ?? '',
            probe: row.probe_dump,
            decision: row.decision,
            reason: row.reason,
            feedId: row.feed_id,
            feedName: row.feed_name,
            upstreamStatus: row.upstream_status,
        })),
        roots: {
            libraryRoots: libraryPaths.map((p) => p.path),
            transcodeRoot: LIVETV_SEGMENT_ROOT,
        },
    };
}
