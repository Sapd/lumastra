// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redactLiveTvUrlsInText } from '$lib/shared/livetv-url-redaction.js';

import type {
    LiveTvSourceSafeRow,
    LiveTvSourceRow,
} from '$lib/server/database/queries/livetv-sources.queries.js';

export interface ApiLiveTvSource {
    id: string;
    name: string;
    sourceType: string;
    maxStreams: number;
    lastRefreshAt?: string;
    lastRefreshStatus?: string;
    refreshCron?: string;
}

export interface ApiLiveTvSourceWithChannelCount extends ApiLiveTvSource {
    channelCount: number;
    lastRefreshError?: string;
    lastImportWarnings: string[];
    /** An M3U source where no channel came with a tvg-id: a bare playlist. */
    playlistMetadataMissing: boolean;
}

/**
 * Map a LiveTV source DB row to API response shape.
 * Handles both safe rows and full rows with credentials.
 */
export function mapSourceToApi(row: LiveTvSourceSafeRow | LiveTvSourceRow): ApiLiveTvSource {
    return {
        id: row.id,
        name: row.name,
        sourceType: row.source_type,
        maxStreams: row.max_streams,
        lastRefreshAt: row.last_refresh_at?.toISOString() ?? undefined,
        lastRefreshStatus: row.last_refresh_status ?? undefined,
        refreshCron: row.refresh_cron ?? undefined,
    };
}

/**
 * Map a source row with channel count and refresh summary to enriched API shape.
 */
export function mapSourceWithChannelCountToApi(
    row: LiveTvSourceSafeRow & {
        channel_count: number;
        tvg_id_count: number;
        last_refresh_summary?: unknown;
    },
): ApiLiveTvSourceWithChannelCount {
    const summary = row.last_refresh_summary as Record<string, unknown> | null;
    const importWarnings = Array.isArray(summary?.warnings) ? (summary.warnings as string[]) : [];

    const epg = summary?.epg as Record<string, unknown> | undefined;
    const guideWarnings = Array.isArray(epg?.warnings) ? (epg.warnings as string[]) : [];
    const error =
        typeof summary?.error === 'string'
            ? summary.error
            : epg?.status === 'failed' && typeof epg.error === 'string'
              ? epg.error
              : undefined;
    return {
        ...mapSourceToApi(row),
        channelCount: row.channel_count,
        lastImportWarnings: [...importWarnings, ...guideWarnings].map(redactLiveTvUrlsInText),
        lastRefreshError: error ? redactLiveTvUrlsInText(error) : undefined,
        // tvg-id, not categories: section headers now give a bare playlist's
        // channels categories, but nothing invents a tvg-id.
        playlistMetadataMissing:
            row.source_type === 'm3u' && row.channel_count > 0 && row.tvg_id_count === 0,
    };
}
