// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getSeriesEpisodeCountsBatch } from '$lib/server/database/queries/series-episode-counts.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isSeries, isSeason } from '$lib/shared/media-types.js';

export interface EpisodeCountFields {
    seasonCount?: number;
    episodeCount?: number;
    availableEpisodeCount?: number;
    watchedEpisodeCount?: number;
    unwatchedEpisodeCount?: number;
}

export interface EpisodeCountTarget extends EpisodeCountFields {
    id: string;
    mediaType?: string;
    type?: string;
}

/** Enrich fresh response objects only, after shared caches. One query per batch. */
export async function enrichSeriesEpisodeCounts<T extends EpisodeCountTarget>(
    sql: postgres.Sql,
    items: T[],
    userId: string | null,
    access: MediaAccessBoundary,
): Promise<void> {
    const targets = items.filter(
        (it) =>
            (isSeries(it.mediaType ?? it.type) || isSeason(it.mediaType ?? it.type)) &&
            /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(it.id),
    );
    if (!targets.length) return;
    const knownTotal = (...values: (number | null | undefined)[]): number | undefined => {
        const known = values.filter((value): value is number => value != null && value > 0);
        return known.length ? Math.max(...known) : undefined;
    };
    // Normalize independent metadata even when the optional query cannot resolve.
    for (const target of targets) {
        target.seasonCount = knownTotal(target.seasonCount);
        target.episodeCount = knownTotal(target.episodeCount);
        delete target.availableEpisodeCount;
        delete target.watchedEpisodeCount;
        delete target.unwatchedEpisodeCount;
    }
    let rows;
    try {
        rows = await getSeriesEpisodeCountsBatch(
            sql,
            [...new Set(targets.map((it) => it.id))],
            userId,
            access,
        );
    } catch (error) {
        Logger.for('series-episode-counts').warn('Episode count enrichment failed', { error });
        return;
    }
    const counts = new Map(rows.map((row) => [row.id, row]));
    for (const target of targets) {
        const row = counts.get(target.id);
        if (!row) continue;
        target.seasonCount = knownTotal(row.seasonCount, target.seasonCount);
        target.episodeCount = knownTotal(
            row.episodeCount,
            target.episodeCount,
            row.availableEpisodeCount,
        );
        target.availableEpisodeCount = row.availableEpisodeCount;
        if (userId) {
            target.watchedEpisodeCount = row.watchedEpisodeCount;
            target.unwatchedEpisodeCount = row.unwatchedEpisodeCount;
        }
    }
}
