// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { Logger } from '../../utils/logger.js';
import { stripSecrets } from '$lib/shared/transcode-failure-report.js';
import { redactLiveTvUrlsInText } from '$lib/shared/livetv-url-redaction.js';
import type {
    LiveTvFailureEvent,
    LiveTvFailureOutcome,
    LiveTvFailureSource,
} from '../../../../shared/livetv-failure-event.js';

const logger = Logger.for('LiveTvFailureEvents');

/** Bound the stored stderr. Matches the sink's own cap so the row holds exactly what
 *  the proxy sent; this is a rail, not a trim. */
const MAX_STDERR_CHARS = 16_000;

/** Bound a serialized probe/decision blob. Both are small structs — this only
 *  protects the column from a future shape that isn't. */
const MAX_JSON_CHARS = 8_000;

export type LiveTvFailureEventInput = LiveTvFailureEvent;

export interface LiveTvFailureEventRow {
    id: string;
    event_uid: string;
    channel_id: string;
    channel_name: string | null;
    occurred_at: Date;
    source: LiveTvFailureSource;
    outcome: LiveTvFailureOutcome;
    exit_code: number | null;
    signal: string | null;
    rung_id: string | null;
    stderr_tail: string | null;
    probe_dump: Record<string, unknown> | null;
    decision: Record<string, unknown> | null;
    reason: string | null;
    feed_id: string | null;
    feed_name: string | null;
    upstream_status: number | null;
}

/**
 * Strip credentials and bound a probe/decision blob before it becomes a row.
 *
 * The proxy sends structured objects, but they are stringified into JSONB and the
 * probe carries the upstream URL FFmpeg was pointed at — which for IPTV routinely
 * embeds a subscriber token. Redacting the serialized form catches it wherever it
 * sits in the object.
 */
function sanitizeJson(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    let serialized: string;
    try {
        serialized = redactLiveTvUrlsInText(stripSecrets(JSON.stringify(value)));
    } catch {
        return null;
    }
    // NEVER slice the JSON: the column is `::jsonb`, so a blob cut mid-token makes
    // Postgres reject the whole INSERT — and the recorder's swallow would then drop
    // the stderr tail too, i.e. the cap would destroy the record it exists to protect.
    if (serialized.length > MAX_JSON_CHARS) {
        return JSON.stringify({ truncated: true, bytes: serialized.length });
    }
    return serialized;
}

/**
 * Append one Live TV failure event. **Non-throwing by contract** — this runs on the
 * drain path behind a live proxy, and a database hiccup must never break the drain
 * loop or a channel. Mirrors `recordTranscodeFailureEvent`'s discipline.
 *
 * Secrets are stripped HERE, before the row exists, so the database never holds a
 * stream token even for the retention window — FFmpeg echoes the input URL, token
 * and all, in its own stderr banner.
 *
 * `ON CONFLICT (event_uid) DO NOTHING`: the proxy generates the uid, so a retried or
 * concurrently-drained batch is idempotent rather than duplicated.
 *
 * Returns true only when this call inserted the row; a duplicate uid or a database
 * error is false, so callers can count each event once (feed health).
 */
export async function recordLiveTvFailureEvent(
    sql: postgres.Sql,
    event: LiveTvFailureEventInput,
): Promise<boolean> {
    try {
        // Keep the END, not the start: FFmpeg's fatal line is the last thing it
        // prints, and the UI's headline is the last non-empty line.
        const stderr = event.stderrTail
            ? redactLiveTvUrlsInText(stripSecrets(event.stderrTail)).slice(-MAX_STDERR_CHARS)
            : null;

        const inserted = await sql<Array<{ id: string }>>`
            INSERT INTO livetv_stream_failure_events (
                event_uid, channel_id, occurred_at, source, outcome,
                exit_code, signal, rung_id, stderr_tail, probe_dump, decision,
                reason, upstream_status, stream_url_index, feed_id
            ) VALUES (
                ${event.eventUid}, ${event.channelId}, ${event.occurredAt},
                ${event.source}, ${event.outcome},
                ${event.exitCode}, ${event.signal}, ${event.rungId},
                ${stderr},
                ${sanitizeJson(event.probe)}::jsonb,
                ${sanitizeJson(event.decision)}::jsonb,
                ${event.reason ?? null}, ${event.upstreamStatus ?? null},
                ${event.streamUrlIndex ?? null}, ${event.feedId ?? null}
            )
            ON CONFLICT (event_uid) DO NOTHING
            RETURNING id::TEXT AS id
        `;
        return inserted.length > 0;
    } catch (err) {
        logger.error('Failed to record livetv failure event', err as Error, {
            channelId: event.channelId,
            source: event.source,
        });
        return false;
    }
}

/**
 * Most recent incidents, newest first, with the channel's display name resolved.
 *
 * Full rows (stderr, probe, decision), not an aggregate: the entire point of the
 * surface is a copy-pasteable report per incident, and a GROUP BY would drop exactly
 * the columns that report is made of. The limit is what keeps the payload sane —
 * these rows are up to ~8KB each.
 *
 * The display name comes from `media_items.title`, NOT from `livetv_channels`: a
 * channel IS a tvchannel media_item (same UUID, `livetv_channels.id` is both PK and
 * FK) and `livetv_channels` has no name column at all.
 *
 * The join is `id::text = channel_id` rather than a cast of `channel_id` to uuid:
 * the proxy reports whatever id the app handed it, and a non-uuid value there must
 * degrade to a null name, not error the whole query.
 */
export async function listLiveTvFailureEvents(
    sql: postgres.Sql,
    limit: number,
): Promise<LiveTvFailureEventRow[]> {
    // Admin-only diagnostics query (the Failures tab lives behind the /admin layout
    // gate) — the media_items join only resolves a display title for a channel the
    // operator is already looking at, not a user's library/age-scoped view, so the
    // row-level access filter this rule normally requires does not apply. Same
    // reasoning as listIncidentSessions in transcode-failure-events.queries.ts.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return sql<LiveTvFailureEventRow[]>`
        SELECT e.id::TEXT AS id,
               e.event_uid,
               e.channel_id,
               mi.title AS channel_name,
               e.occurred_at,
               e.source,
               e.outcome,
               e.exit_code,
               e.signal,
               e.rung_id,
               e.stderr_tail,
               e.probe_dump,
               e.decision,
               e.reason,
               e.feed_id,
               fmi.title AS feed_name,
               e.upstream_status
          FROM livetv_stream_failure_events e
          LEFT JOIN livetv_channels c ON c.id::TEXT = e.channel_id
          LEFT JOIN media_items mi ON mi.id = c.id
          LEFT JOIN livetv_channels fc ON fc.id::TEXT = e.feed_id
          LEFT JOIN media_items fmi ON fmi.id = fc.id
         ORDER BY e.occurred_at DESC, e.id DESC
         LIMIT ${limit}
    `;
}

/**
 * LIMIT-batched delete, driven by `pruneUntilDrained`. A channel failing in a loop
 * produces rows steadily, so an unbounded single-pass DELETE could hold a long write
 * lock after a bad night.
 */
export async function pruneLiveTvFailureEvents(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM livetv_stream_failure_events
        WHERE id IN (
            SELECT id FROM livetv_stream_failure_events
            WHERE occurred_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}
