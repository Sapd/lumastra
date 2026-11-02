// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Catalog-Match Filter
 *
 * A pending Jellyseerr request can reference a TMDB title that Lumastra's
 * own catalog (`media_items` + `external_ids`) does not have a row for.
 * That happens when the user requested a title via Seerr that Lumastra
 * never imported — Seerr is happy, Sonarr/Radarr is happy, but Lumastra
 * has nothing to anchor user data against.
 *
 * Dismissal itself works for these (the keyed `user_notification_dismissals`
 * table has no FK to media_items), but the popup row would render with no
 * poster, no metadata, and no working "open modal" path. We drop those
 * entries before building the payload so the widget only shows actionable
 * items. Sibling to the *arr orphan filter.
 */
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { JellyseerrRequest } from '$lib/server/jellyseerr.js';

const logger = Logger.for('CatalogMatchFilter');

interface MatchRow {
    external_id: string;
    media_type: string;
}

/**
 * Drop pending requests whose TMDB id has no matching `media_items`
 * row. Returns the filtered list and a count of dropped entries.
 *
 * Fails-open on DB errors: if the lookup fails, every request is kept
 * (better to leave one stuck row than to wrongly hide legitimate ones).
 */
export async function filterRequestsWithoutCatalogMatch(
    requests: JellyseerrRequest[],
): Promise<{ kept: JellyseerrRequest[]; orphansDropped: number }> {
    if (requests.length === 0) {
        return { kept: requests, orphansDropped: 0 };
    }

    const db = getDb();
    if (!db) {
        return { kept: requests, orphansDropped: 0 };
    }

    // Jellyseerr only carries TMDB ids on the request payload — that's the
    // single (provider, external_id, media_type) tuple we need to probe.
    const tmdbIds = requests
        .map((r) => ({
            tmdb: r.media.tmdbId,
            // Jellyseerr's mediaType is 'movie' or 'tv'; external_ids stores
            // the same lowercase form for the catalog rows we care about.
            mediaType: r.type,
        }))
        .filter(
            (k): k is { tmdb: number; mediaType: 'movie' | 'tv' } =>
                typeof k.tmdb === 'number' && k.tmdb > 0,
        );

    if (tmdbIds.length === 0) {
        return { kept: requests, orphansDropped: 0 };
    }

    try {
        const ids = tmdbIds.map((k) => String(k.tmdb));
        const types = tmdbIds.map((k) => k.mediaType);

        // Single batch lookup. We constrain on both external_id and
        // media_type because a TMDB id is NOT unique across types
        // (e.g. tmdb 1429 = "25th Hour" movie AND "Attack on Titan" tv).
        const rows = (await db`
            SELECT external_id, media_type
            FROM external_ids
            WHERE provider = 'tmdb'
              AND (external_id, media_type) IN (
                  SELECT * FROM unnest(${ids}::text[], ${types}::text[])
              )
        `) as unknown as MatchRow[];

        const matched = new Set(rows.map((r) => `${r.external_id}:${r.media_type}`));

        const kept: JellyseerrRequest[] = [];
        let orphansDropped = 0;
        for (const req of requests) {
            const key = `${req.media.tmdbId}:${req.type}`;
            if (matched.has(key)) {
                kept.push(req);
            } else {
                orphansDropped += 1;
            }
        }

        if (orphansDropped > 0) {
            logger.info('Hid pending requests with no Lumastra catalog match', {
                orphansDropped,
                total: requests.length,
            });
        }

        return { kept, orphansDropped };
    } catch (error) {
        logger.warn('Catalog-match probe failed; keeping all requests', {
            error: error instanceof Error ? error.message : String(error),
        });
        return { kept: requests, orphansDropped: 0 };
    }
}
