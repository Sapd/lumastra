// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media_item_translations query module — per-language display metadata
 * (title/overview/tagline).
 *
 * The TMDB write pipeline (a later task) populates this table per media
 * item; the read overlay (also a later task) uses `getTranslationMapForItems`
 * to swap in a viewer's preferred language when present. Rows for
 * `metadata_locked` items are excluded from lookups so hand-edited titles
 * (admin UI) are never shadowed by a stale/foreign-language translation.
 *
 * Pure SQL: every function takes `sql: postgres.Sql` first and has no side
 * effects beyond the statement it runs (per the queries/ tier contract).
 */

import type postgres from 'postgres';

/** One language's translation to persist for a media item. */
export interface MediaTranslationInput {
    /** ISO 639-1 language code ('de', 'ja', …). Trimmed; blank is skipped. */
    language: string;
    title?: string | null;
    overview?: string | null;
    tagline?: string | null;
}

/** A stored translation's display fields. */
export interface MediaTranslationFields {
    title: string | null;
    overview: string | null;
    tagline: string | null;
}

/**
 * Upsert per-language display translations for a media item. Idempotent:
 * re-syncing a language updates the existing row rather than duplicating
 * (media_id, language) is the primary key. Blank/whitespace-only strings are
 * normalized to NULL; an input whose title/overview/tagline are all blank is
 * skipped entirely (no all-NULL rows). Duplicate languages within the same
 * batch keep only the first occurrence. No-op for an empty list.
 *
 * Returns the number of rows inserted or updated.
 */
export async function upsertMediaTranslations(
    sql: postgres.Sql,
    mediaId: string,
    inputs: MediaTranslationInput[],
    source = 'tmdb',
): Promise<number> {
    const rows: Record<string, string | null>[] = [];
    const seen = new Set<string>();
    for (const t of inputs) {
        const language = t.language?.trim();
        if (!language || seen.has(language)) continue;
        seen.add(language);
        const title = t.title?.trim() || null;
        const overview = t.overview?.trim() || null;
        const tagline = t.tagline?.trim() || null;
        if (!title && !overview && !tagline) continue;
        rows.push({ media_id: mediaId, language, title, overview, tagline, source });
    }
    if (rows.length === 0) return 0;
    const result = await sql`
        INSERT INTO media_item_translations ${sql(rows, 'media_id', 'language', 'title', 'overview', 'tagline', 'source')}
        ON CONFLICT (media_id, language) DO UPDATE SET
            title = EXCLUDED.title,
            overview = EXCLUDED.overview,
            tagline = EXCLUDED.tagline,
            source = EXCLUDED.source,
            updated_at = now()
    `;
    return result.count;
}

/**
 * Batch translation lookup for the read overlay: one language across many
 * media items. Excludes `metadata_locked` items so an admin's hand-edited
 * title/overview is never overridden by a stored translation.
 *
 * Returns an empty map (no query) when `ids` is empty or `language` is blank.
 */
export async function getTranslationMapForItems(
    sql: postgres.Sql,
    ids: string[],
    language: string,
): Promise<Map<string, MediaTranslationFields>> {
    const map = new Map<string, MediaTranslationFields>();
    if (ids.length === 0 || !language) return map;
    // The media_items join below only checks metadata_locked (it never
    // returns a media_items column); library/age access is the caller's
    // responsibility since `ids` is expected to already be an
    // access-checked set.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<
        {
            media_id: string;
            title: string | null;
            overview: string | null;
            tagline: string | null;
        }[]
    >`
        SELECT t.media_id, t.title, t.overview, t.tagline
        FROM media_item_translations t
        JOIN media_items mi ON mi.id = t.media_id AND mi.metadata_locked IS NOT TRUE
        WHERE t.media_id = ANY(${ids}::uuid[]) AND t.language = ${language}
    `;
    for (const r of rows)
        map.set(r.media_id, { title: r.title, overview: r.overview, tagline: r.tagline });
    return map;
}

/**
 * Whether a translation row exists for (mediaId, language) — used by the
 * lazy-fill path (a later task) to decide whether to fetch-and-store before
 * serving a request.
 */
export async function hasTranslation(
    sql: postgres.Sql,
    mediaId: string,
    language: string,
): Promise<boolean> {
    const rows =
        await sql`SELECT 1 FROM media_item_translations WHERE media_id = ${mediaId} AND language = ${language} LIMIT 1`;
    return rows.length > 0;
}
