// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Quality Filter Builder
 *
 * Produces a SQL fragment restricting /browse results by resolution/HDR/codec
 * tier, correlated on the `mi` alias against the media_item_quality
 * projection (see migration 16.150.0). Unlike track languages, quality is a
 * single row per item — resolution/hdr/codec dimensions are ANDed within
 * one EXISTS rather than separate per-kind EXISTS clauses.
 */

import type postgres from 'postgres';

export interface QualityFilterOptions {
    resolutions?: string[];
    hdr?: string[];
    codecs?: string[];
    includeUnknown?: boolean;
}

/**
 * Build a WHERE clause fragment that filters media items by resolution/HDR/
 * codec tier against the media_item_quality projection.
 *
 * - AND across dimensions: an item's single quality row must satisfy every
 *   active dimension (resolutions/hdr/codecs) simultaneously.
 * - includeUnknown: also match items with NO projection row at all
 *   (unprobed — no video stream has been analyzed yet).
 * - Returns an empty fragment (matches everything) when resolutions, hdr,
 *   and codecs are all empty.
 *
 * @param sql - postgres.Sql instance for parameterized queries
 * @param opts - quality filter options
 * @returns SQL fragment to append after existing WHERE conditions (includes leading AND when active)
 */
export function buildQualityFilter(
    sql: postgres.Sql,
    opts: QualityFilterOptions,
): postgres.PendingQuery<postgres.Row[]> {
    const { resolutions = [], hdr = [], codecs = [], includeUnknown = false } = opts;

    if (resolutions.length === 0 && hdr.length === 0 && codecs.length === 0) {
        return sql``;
    }

    const resolutionPredicate =
        resolutions.length > 0 ? sql`AND q.resolution_tier = ANY(${resolutions})` : sql``;
    const hdrPredicate = hdr.length > 0 ? sql`AND q.hdr_tier = ANY(${hdr})` : sql``;
    const codecPredicate = codecs.length > 0 ? sql`AND q.codec = ANY(${codecs})` : sql``;

    const matchExists = sql`EXISTS (
        SELECT 1 FROM media_item_quality q
        WHERE q.media_item_id = mi.id
          ${resolutionPredicate}
          ${hdrPredicate}
          ${codecPredicate}
    )`;
    const unknownBranch = includeUnknown
        ? sql`OR NOT EXISTS (
            SELECT 1 FROM media_item_quality q2
            WHERE q2.media_item_id = mi.id
        )`
        : sql``;

    return sql`AND (${matchExists} ${unknownBranch})`;
}
