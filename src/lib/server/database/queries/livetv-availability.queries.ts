// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
export interface AvailabilityFeedRow {
    source_id: string;
    feed: 'channels' | 'guide';
    state: 'completed' | 'failed';
    at: Date;
}
export interface AvailabilityFailureRow {
    channel_id: string;
    occurred_at: Date;
    source: string;
    outcome: string;
    stderr_tail: string | null;
    reason: string | null;
}
export async function getLiveTvFeedEvidence(sql: postgres.Sql): Promise<AvailabilityFeedRow[]> {
    const query = sql<AvailabilityFeedRow[]>`
        SELECT DISTINCT ON (input->>'sourceId', CASE WHEN task_id IN ('import-m3u','refresh-m3u') THEN 'channels' ELSE 'guide' END)
            input->>'sourceId' AS source_id,
            CASE WHEN task_id IN ('import-m3u','refresh-m3u') THEN 'channels' ELSE 'guide' END AS feed,
            state, COALESCE(completed_at, started_at) AS at
        FROM task_history
        WHERE task_id IN ('import-m3u','refresh-m3u','import-epg','refresh-epg')
            AND state IN ('completed','failed')
            -- Sargable form of COALESCE(completed_at, started_at) > cutoff: the
            -- COALESCE alone seq-scanned task_history (455 MB on prod, ~37k
            -- buffers) on every call; this answers from the completed_at and
            -- started_at indexes (~2.6k). Same rows.
            AND (
                completed_at > NOW() - INTERVAL '24 hours'
                OR (completed_at IS NULL AND started_at > NOW() - INTERVAL '24 hours')
            )
        ORDER BY input->>'sourceId', CASE WHEN task_id IN ('import-m3u','refresh-m3u') THEN 'channels' ELSE 'guide' END,
            COALESCE(completed_at, started_at) DESC, started_at DESC
    `;
    const timer = setTimeout(() => {
        void query.cancel();
    }, 2000);
    try {
        return await query;
    } finally {
        clearTimeout(timer);
    }
}
export async function getLiveTvPlaybackEvidence(
    sql: postgres.Sql,
): Promise<AvailabilityFailureRow[]> {
    const query = sql<AvailabilityFailureRow[]>`
        SELECT DISTINCT ON (channel_id) channel_id, occurred_at, source, outcome, stderr_tail, reason
        FROM livetv_stream_failure_events
        WHERE occurred_at > NOW() - INTERVAL '2 hours' AND source = 'ingest'
        ORDER BY channel_id, occurred_at DESC
    `;
    const timer = setTimeout(() => {
        void query.cancel();
    }, 2000);
    try {
        return await query;
    } finally {
        clearTimeout(timer);
    }
}
