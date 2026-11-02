// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview.js';
import {
    buildPlaybackProgress,
    type PlaybackProgress,
} from '$lib/schemas/api-playback-progress.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import type { CatalogBookRow } from '$lib/server/database/queries/audiobook-catalog.queries.js';

export function bookProgress(
    row: Pick<
        CatalogBookRow,
        'state_id' | 'position_ms' | 'duration_ms' | 'finished' | 'updated_at'
    >,
): PlaybackProgress | undefined {
    if (!row.state_id) return undefined;
    // A rating/dismissal can create a state row without a listen.
    if (!row.finished && (row.position_ms === null || Number(row.position_ms) === 0))
        return undefined;
    const durationMs = row.duration_ms === null ? null : Number(row.duration_ms);
    const position = row.position_ms === null ? null : Math.max(0, Number(row.position_ms));
    // Preserve the reported position, including zero when a finished book was reset.
    const positionMs =
        position !== null && durationMs !== null && durationMs > 0
            ? Math.min(position, durationMs)
            : position;
    return buildPlaybackProgress({
        positionMs,
        durationMs,
        fraction: row.finished ? 1 : null,
        finished: row.finished,
        updatedAt: row.updated_at,
    });
}

/** A collapsed shelf retains book identity and aggregates completion over visible siblings. */
export function audiobookRowToPreview(row: CatalogBookRow, images: ImageSet): AudiobookPreview {
    const count = row.series?.bookCount;
    const progress =
        count && count > 1 && row.series_finished_count !== undefined
            ? buildPlaybackProgress({
                  positionMs:
                      row.series_duration_ms === null || row.series_duration_ms === undefined
                          ? null
                          : Math.round(
                                (Number(row.series_duration_ms) *
                                    Number(row.series_finished_count)) /
                                    count,
                            ),
                  durationMs:
                      row.series_duration_ms === null || row.series_duration_ms === undefined
                          ? null
                          : Number(row.series_duration_ms),
                  fraction: Number(row.series_finished_count) / count,
                  finished: Number(row.series_finished_count) === count,
                  updatedAt: row.updated_at?.toISOString() ?? null,
              })
            : bookProgress(row);
    return {
        id: row.id,
        catalogId: row.id,
        type: 'audiobook',
        ids: row.ids,
        title: row.title,
        ...(row.authors.length ? { subtitle: row.authors.map((a) => a.name).join(', ') } : {}),
        ...(row.year !== null ? { year: row.year } : {}),
        images,
        availability: { isAvailable: true, hasFile: true, canRequest: false },
        ...(progress ? { progress } : {}),
        audiobook: { authors: row.authors, narrators: row.narrators, series: row.series },
    };
}
