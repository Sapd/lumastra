// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/music/sections/mood-shelf?mood=<key>
 *
 * Rotating mood-shelf carousel — tracks ranked by cosine similarity, in CLAP
 * audio-embedding space, to the pre-computed MSCLAP mood vector for the given
 * key, with an optional Essentia energy band and a light taste blend toward
 * artists the user has actually played. `mood` must be one of the bare
 * mood-chip keys in `$lib/constants/music-moods` (the `music:` mood_vectors
 * namespace prefix is added server-side). Internal BFF — dashboard only, not
 * published on the v1 external surface.
 *
 * Response: bare `PageSection | null` (the consumer, LazySection.svelte,
 * reads `await res.json() as PageSection | null` directly — NOT a wrapper).
 *   - null when the `msclap-2023` mood_vectors row is missing (by design —
 *     mood shelves only show with real audio-space mood data) or fewer than
 *     4 tracks match.
 *
 * Unknown/missing mood → 400 validation_failed.
 * DB-down → 503 dependency_unavailable.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { PageSectionSchema } from '$lib/schemas/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getMoodShelfTracks } from '$lib/server/database/queries/music-recommendations.queries.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { buildMoodShelfSection } from '$lib/server/utils/music-section-builder.js';
import {
    buildSearchAccessContext,
    scopedCacheKey,
} from '$lib/server/utils/search-access-context.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { MOOD_CHIPS } from '$lib/constants/music-moods.js';
import { toString } from '$lib/utils/data-extraction.js';
import type { PageSection } from '$lib/types/server-driven-ui';
import { musicMoodVectorKey } from '$lib/server/database/queries/sonic-queue.queries.js';

const logger = Logger.for('MoodShelfSectionDef');

const TRACK_LIMIT = 20;
const MIN_TRACKS = 4;

interface EnergyBand {
    energyMin?: number;
    energyMax?: number;
}

// High-energy moods get an energy floor, calm moods get an energy ceiling.
// The remaining chips (sad/happy/romantic) span too wide an energy range in
// practice to bound safely, so they run unfiltered on energy.
const MOOD_ENERGY_BANDS: Partial<Record<string, EnergyBand>> = {
    workout: { energyMin: 0.55 },
    party: { energyMin: 0.55 },
    energetic: { energyMin: 0.55 },
    chill: { energyMax: 0.5 },
    focus: { energyMax: 0.5 },
};

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get a mood-shelf carousel',
            stability: 'beta',
            auth: 'bearer',
            description:
                'A carousel for one mood, ranked by cosine similarity in CLAP audio-embedding space with a light blend toward artists the caller actually plays. `mood` takes a bare key from `music/moods` (the `music:` namespace is added server-side). Returns `null` (HTTP 200) when that mood has no audio-space vector on this install or fewer than 4 tracks match — call `music/moods` rather than hardcoding keys.',
            responses: {
                200: {
                    schema: PageSectionSchema.nullable(),
                    description: 'Carousel section, or null when there is nothing to show',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
            },
        },
    },

    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const moodParam = toString(event.url.searchParams.get('mood'));
            const chip = moodParam ? MOOD_CHIPS.find((c) => c.genre === moodParam) : undefined;
            if (!chip) {
                return ApiProblem.validationFailed('Unknown or missing mood key');
            }

            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('AI database is unavailable');
            }

            try {
                const accessCtx = await buildSearchAccessContext(sql, user);

                // Per-user cache: the ranking blends toward the user's played
                // artists, so the key carries the userId (unlike the access-only
                // mood-recommendations cache). The built items carry
                // surface-resolved ImageSets, so the surface is part of the key
                // too. Wrapped value so a cached null (fewer than MIN_TRACKS
                // matches) reads as a hit, not a miss.
                const cache = cacheManager.for(CACHE_NAMESPACES.musicMoodShelf);
                const cacheKey = scopedCacheKey('music-mood-shelf-dto-v3', accessCtx, [
                    user.userId,
                    chip.genre,
                    ctx.surface,
                ]);
                const cached = await cache.get<{ section: PageSection | null }>(cacheKey);
                if (cached) return json(cached.section);

                const moodKey = musicMoodVectorKey(chip.genre);
                const energyBand = MOOD_ENERGY_BANDS[chip.genre] ?? null;

                const tracks = await getMoodShelfTracks(
                    sql,
                    user.userId,
                    moodKey,
                    TRACK_LIMIT,
                    {
                        deniedGroupIds: accessCtx.deniedGroupIds,
                        ageRating: accessCtx.ageRating,
                    },
                    energyBand,
                );

                const section: PageSection | null =
                    tracks.length < MIN_TRACKS
                        ? null
                        : buildMoodShelfSection(
                              chip,
                              tracks,
                              await resolveImageSets(
                                  sql,
                                  ctx.surface,
                                  tracks.map((t) => ({ id: t.id, mediaType: 'track' })),
                              ),
                          );
                void cache.set(cacheKey, { section });
                return json(section);
            } catch (err) {
                logger.error('Mood shelf section endpoint failed', err as Error);
                return ApiProblem.dependencyUnavailable(
                    'Recommendations are temporarily unavailable',
                );
            }
        },
    },
});
