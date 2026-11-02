// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Track Language Filter Builder
 *
 * Produces a SQL fragment restricting /browse results by audio and/or
 * subtitle track language, correlated on the `mi` alias against the
 * media_item_languages projection (see migration 16.148.0).
 */

import type postgres from 'postgres';

export interface TrackLanguageFilterOptions {
    audioLangs?: string[];
    subLangs?: string[];
    includeUnknown?: boolean;
}

/**
 * Build a WHERE clause fragment that filters media items by audio/subtitle
 * track language against the media_item_languages projection.
 *
 * - OR within a kind: an item matches if any of its languages for that kind
 *   is in the selected set.
 * - AND across kinds: when both audioLangs and subLangs are given, an item
 *   must satisfy both.
 * - includeUnknown: also match items with NO projection rows of that kind
 *   (untagged). This is distinct from items tagged 'other' (probed but
 *   out-of-set), which never pass — they have a row, just not a matching one.
 * - Returns an empty fragment (matches everything) when neither audioLangs
 *   nor subLangs is non-empty.
 *
 * @param sql - postgres.Sql instance for parameterized queries
 * @param opts - language filter options
 * @returns SQL fragment to append after existing WHERE conditions (includes leading AND per active kind)
 */
export function buildTrackLanguageFilter(
    sql: postgres.Sql,
    opts: TrackLanguageFilterOptions,
): postgres.PendingQuery<postgres.Row[]> {
    const { audioLangs = [], subLangs = [], includeUnknown = false } = opts;

    const kindFragment = (
        kind: 'audio' | 'subtitle',
        langs: string[],
    ): postgres.PendingQuery<postgres.Row[]> => {
        if (langs.length === 0) return sql``;

        const matchExists = sql`EXISTS (
            SELECT 1 FROM media_item_languages mil
            WHERE mil.media_item_id = mi.id AND mil.kind = ${kind}
              AND mil.language = ANY(${langs})
        )`;
        const unknownBranch = includeUnknown
            ? sql`OR NOT EXISTS (
                SELECT 1 FROM media_item_languages milu
                WHERE milu.media_item_id = mi.id AND milu.kind = ${kind}
            )`
            : sql``;

        return sql`AND (${matchExists} ${unknownBranch})`;
    };

    return sql`${kindFragment('audio', audioLangs)} ${kindFragment('subtitle', subLangs)}`;
}
