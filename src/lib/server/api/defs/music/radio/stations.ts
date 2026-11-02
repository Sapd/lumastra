// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/radio/stations.ts — GET /api/music/radio
 * (also mounted at GET /api/v1/music/radio/stations)
 *
 * Returns the access-scoped list of internet radio stations.
 *
 * Contract:
 *  - Collection envelope: { items, page } via paginate().
 *  - Each station carries a self-describing images{} href map (poster/backdrop)
 *    instead of a flat logoUrl — the surface comes from the surface ctx so
 *    internal callers get /api/image/... and v1 callers get /api/v1/media/...
 *  - When radio is not configured (no stations in DB) the response is
 *    { items: [], page: { limit: 0, offset: 0, hasMore: false, total: 0 } }
 *    rather than 404, so clients render the same "no stations" empty state
 *    used when access scoping filters all rows.
 *  - DB unavailable → 503 dependency_unavailable (NEVER 200 with empty array).
 *
 * Access: any authenticated user; age-boundary scoped. Library-group scoping
 * is wired via the canonical buildLibraryAccessFilter but is a NO-OP today —
 * no radio row ever carries a library_group_id or owns media_file_items, and
 * there is no radio capability flag (unlike Live TV's hasLiveTvPermission).
 * See the in-handler comment for the full explanation; this is a parked
 * product question, not a bug this def can fix alone.
 * Surface: 'internal' on /api/music/radio, 'v1' on /api/v1/music/radio/stations.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { isRadioConfigured } from '$lib/server/services/music/radio-configured.service.js';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import { buildImageRefs } from '$lib/shared/api-urls.js';
import { RadioStationsResponseSchema } from '$lib/schemas/api-music-responses';

const logger = Logger.for('MusicRadioStationsDef');

interface RadioStationRow {
    id: string;
    title: string;
    custom_metadata: Record<string, unknown>;
    custom_poster_url: string | null;
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'List internet radio stations',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: RadioStationsResponseSchema,
                    description:
                        'Access-scoped list of radio stations. Empty collection when radio is not configured or all stations are filtered — never 404.',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },

    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            // Radio is only available when configured (≥1 radio station exists).
            // Return an empty collection rather than 404 so clients render the
            // same "no stations" empty state used when access scoping filters all rows.
            if (!(await isRadioConfigured(sql))) {
                return json(paginate([], { limit: 0, offset: 0, hasMore: false, total: 0 }));
            }

            // Scope by the caller's library + age boundary via the canonical
            // `buildLibraryAccessFilter` — the same predicate every other
            // media type uses (Shape A: do not hand-inline a sixth copy).
            //
            // NOTE — this is currently a NO-OP for `radio`, not a working
            // gate: no writer (`admin/radio/index.ts`) ever sets
            // `library_group_id` on a radio row, and radio rows never own
            // `media_file_items` either, so both disjuncts this predicate can
            // apply — the leaf's own-column check and its own-files EXISTS —
            // are vacuously true for every radio row. There is also no
            // capability flag for radio (no `hasRadioPermission`, unlike Live
            // TV's `hasLiveTvPermission`). A restricted user therefore DOES
            // see every station's title, genre and logo today regardless of
            // library group — this call does not close that gap, it only
            // stops hand-duplicating the (currently vacuous) predicate and
            // makes the filter start working automatically the moment radio
            // gets a real group/capability axis. (Radio access scoping is PARKED as a
            // product question, same as Live TV's per-source entitlement — not
            // decided yet.)
            const accessCtx = await buildSearchAccessContext(sql, user);
            const denied = accessCtx.deniedGroupIds;
            const age = accessCtx.ageRating;

            const rows = await sql<RadioStationRow[]>`
				SELECT
					mi.id,
					mi.title,
					COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
					mi.custom_poster_url
				FROM media_items mi
				WHERE mi.media_type = 'radio'
				  ${buildLibraryAccessFilter(sql, denied, 'mi')}
				  ${
                      age && age.maxAgeRating !== null
                          ? sql`AND (
					(mi.age_rating IS NULL AND ${age.allowUnrated}::boolean)
					OR mi.age_rating <= ${age.maxAgeRating}
				)`
                          : sql``
                  }
				ORDER BY mi.title ASC
			`;

            const surface = ctx.surface;

            // Deliberately omit the upstream stream URL — clients play via
            // /api/music/radio/{id}/stream so they never connect direct to the
            // Icecast/Shoutcast origin. Admins use /api/admin/radio instead.
            //
            // Images are self-describing via images{} href map. The poster href
            // points to the catalog image surface; it 404s when no local file
            // exists (custom_poster_url is null), falling back to the 📻 UI placeholder.
            const items = rows.map((row) => ({
                id: row.id,
                type: 'radio' as const,
                name: row.title,
                genre: row.custom_metadata.genre as string | undefined,
                nowPlaying: row.custom_metadata.now_playing as string | undefined,
                images: row.custom_poster_url ? buildImageRefs(row.id, surface) : undefined,
            }));

            logger.debug('Radio stations listed', {
                username: user.username,
                count: items.length,
            });

            return json(
                paginate(items, {
                    limit: items.length,
                    offset: 0,
                    hasMore: false,
                    total: items.length,
                }),
            );
        },
    },
});
