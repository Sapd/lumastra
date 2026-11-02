// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildSeriesOwnedAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything, type MediaAccessBoundary } from './builders/media-access-boundary.js';
import {
    matchKeysForSql,
    primaryTitleMatches,
    secondaryTitle,
    selectMatchedTitle,
} from '$lib/utils/search/matched-title.js';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('SearchMatchedTitles');

/** The explanation is optional decoration: it may never hold a search request or a pool slot. */
export const MATCHED_TITLE_STATEMENT_TIMEOUT_MS = 250;
/**
 * statement_timeout does not cover waiting for a pooled connection, so the
 * whole lookup is also raced against this; a late result is dropped.
 */
export const MATCHED_TITLE_LOOKUP_DEADLINE_MS = 500;
/** Per-id cap on alias rows read back; the page size already bounds the id list. */
const MAX_ALIASES_PER_ID = 8;

interface SearchTitleRow {
    id: string;
    type: string;
    title: string;
    matchedTitle?: string;
}
interface StoredTitle {
    media_id: string;
    title: string;
}

/**
 * Stored titles of the final-page video IDs that the database itself matches
 * against the query, best match first per id (exact, then whole-phrase, then
 * shorter). Runs in its own transaction under a short statement_timeout so a
 * slow plan fails fast instead of stalling search; callers treat a throw as
 * "no decoration".
 */
export async function storedSearchTitles(
    sql: postgres.Sql,
    ids: string[],
    access: MediaAccessBoundary,
    query: string,
): Promise<StoredTitle[]> {
    const keys = matchKeysForSql(query);
    if (ids.length === 0 || keys.length === 0 || deniesEverything(access)) return [];
    return sql.begin(async (trx) => {
        const tx = trx as unknown as postgres.Sql;
        await tx.unsafe(`SET LOCAL statement_timeout = ${MATCHED_TITLE_STATEMENT_TIMEOUT_MS}`);
        return tx<StoredTitle[]>`
            WITH keys AS (
                SELECT k->>'text' AS text,
                       ARRAY(SELECT jsonb_array_elements_text(k->'words')) AS words
                FROM jsonb_array_elements(${JSON.stringify(keys)}::text::jsonb) k
            ), matched AS (
                SELECT mi.id::text AS media_id, candidates.title, n.norm,
                    EXISTS (SELECT 1 FROM keys k WHERE k.text = btrim(n.norm)) AS is_exact,
                    EXISTS (SELECT 1 FROM keys k WHERE position(k.text IN n.norm) > 0) AS is_phrase
                FROM media_items mi
                CROSS JOIN LATERAL (
                    SELECT mt.title FROM media_titles mt WHERE mt.media_id = mi.id
                    UNION SELECT mi.title
                    UNION SELECT mi.original_title
                    UNION SELECT mi.english_title
                ) candidates
                -- Both forms matchKeys() builds: plain unaccent, and German
                -- digraphs (ä -> ae) so "aerger" still finds "Ärger".
                CROSS JOIN LATERAL (
                    SELECT regexp_replace(lower(immutable_unaccent(candidates.title)),
                                          '[^[:alnum:]]+', ' ', 'g') AS norm
                    UNION
                    SELECT regexp_replace(lower(immutable_unaccent(
                               replace(replace(replace(lower(normalize(candidates.title, NFC)),
                                   'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'))),
                           '[^[:alnum:]]+', ' ', 'g')
                ) n
                WHERE mi.id = ANY(${ids}::uuid[]) AND candidates.title IS NOT NULL
                ${buildLibraryAccessFilter(tx, access.library)}
                ${buildSeriesOwnedAgeRatingFilter(tx, access.age)}
            ), ranked AS (
                SELECT media_id, title,
                    row_number() OVER (
                        PARTITION BY media_id
                        ORDER BY bool_or(is_exact) DESC, bool_or(is_phrase) DESC,
                                 min(length(norm)), title
                    ) AS pos
                FROM matched m
                WHERE EXISTS (
                    SELECT 1 FROM keys k
                    WHERE position(k.text IN m.norm) > 0
                       OR NOT EXISTS (
                            SELECT 1 FROM unnest(k.words) w WHERE m.norm !~ ('(^| )' || w)
                       )
                )
                GROUP BY media_id, title
            )
            SELECT media_id, title FROM ranked
            WHERE pos <= ${MAX_ALIASES_PER_ID}
            ORDER BY media_id, pos
        `;
    });
}

/**
 * Runs AFTER the language overlay; always clone so L1's shared rows remain neutral.
 * The database's ranked match decides which alias is shown; the in-process
 * selector only re-ranks among rows the database already returned, so it can
 * never name a title the database did not match.
 */
export async function decorateSearchMatchedTitles<T extends SearchTitleRow>(
    sql: postgres.Sql,
    items: T[],
    query: string,
    access: MediaAccessBoundary,
): Promise<T[]> {
    const clones = items.map((item) => {
        const response = { ...item };
        delete response.matchedTitle;
        return response;
    });
    const ids = [
        ...new Set(
            items
                .filter(
                    (item) =>
                        (item.type === 'movie' || item.type === 'series') && UUID_RE.test(item.id),
                )
                .map((item) => item.id),
        ),
    ];
    let titles: StoredTitle[];
    try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error('matched-title lookup deadline exceeded')),
                MATCHED_TITLE_LOOKUP_DEADLINE_MS,
            );
        });
        const lookup = storedSearchTitles(sql, ids, access, query);
        // A lookup that loses the race still settles; never leave it unhandled.
        lookup.catch(() => undefined);
        try {
            titles = await Promise.race([lookup, deadline]);
        } finally {
            clearTimeout(timer);
        }
    } catch (error) {
        logger.warn('Matched-title lookup failed; returning results undecorated', {
            error: error instanceof Error ? error.message : String(error),
        });
        return clones;
    }
    const byId = new Map<string, string[]>();
    for (const row of titles)
        byId.set(row.media_id, [...(byId.get(row.media_id) ?? []), row.title]);
    for (const response of clones) {
        const matched = byId.get(response.id);
        if (!matched || primaryTitleMatches(response.title, query)) continue;
        const matchedTitle =
            matched
                .map((candidate) => secondaryTitle(candidate, response.title))
                .find((candidate) => candidate !== undefined) ??
            selectMatchedTitle(response.title, query, matched);
        if (matchedTitle) response.matchedTitle = matchedTitle;
    }
    return clones;
}
