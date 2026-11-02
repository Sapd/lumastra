// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/unmatched-files/[id]/children
 *
 * Returns the season/episode breakdown for a personal series.
 * Used for the expandable series view in the Personal Media tab.
 *
 * Auth: media:admin. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getSeriesChildren } from '$lib/server/database/queries/media-items.queries.js';
import type { PersonalSeason } from '$lib/schemas/api-admin-unmatched-responses.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const ParamsSchema = z.object({
    id: z.string().regex(UUID_RE, 'Invalid UUID'),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    visibility: 'internal',
    request: {
        params: ParamsSchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const { id } = ctx.input!.params;

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rows = await getSeriesChildren(sql, id);

            // Group flat rows into season → episodes tree.
            const seasonMap = new Map<string, PersonalSeason>();
            const episodesSeen = new Set<string>();
            for (const row of rows) {
                if (episodesSeen.has(row.episode_id)) continue;
                episodesSeen.add(row.episode_id);

                let season = seasonMap.get(row.season_id);
                if (!season) {
                    season = {
                        id: row.season_id,
                        season_number: row.season_number,
                        title: row.season_title,
                        episodes: [],
                    };
                    seasonMap.set(row.season_id, season);
                }
                season.episodes.push({
                    id: row.episode_id,
                    episode_number: row.episode_number,
                    title: row.episode_title,
                    file_path: row.file_path ?? undefined,
                    file_size_bytes: row.file_size_bytes ?? undefined,
                    duration_seconds: row.duration_seconds ?? undefined,
                });
            }

            for (const season of seasonMap.values()) {
                season.episodes.sort((a, b) => a.episode_number - b.episode_number);
            }
            const seasons = Array.from(seasonMap.values()).sort((a, b) => {
                const diff = a.season_number - b.season_number;
                return diff !== 0 ? diff : a.id.localeCompare(b.id);
            });

            return json({ seasons });
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
