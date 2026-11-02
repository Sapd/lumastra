// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/moods.ts — GET music/moods
 *
 * The selectable mood vocabulary for `music/mood-recommendations`.
 *
 * WHY THIS EXISTS: `?mood=` is a free-form string that gets the `music:`
 * namespace prefix and is looked up in `mood_vectors`. A key with no row
 * returns an empty result rather than an error, so a client had no way to tell
 * "this mood matched nothing right now" from "this mood does not exist here" —
 * any hardcoded list would eventually render a chip that is permanently empty.
 * Which moods work is per-install: `mood_vectors` is filled by the
 * `mood-vector-generation` task against the local library.
 *
 * Emits the curated chip row (MOOD_CHIPS — the same list the web /music page
 * renders, carrying label + emoji) INTERSECTED with the keys that actually
 * have an MSCLAP audio-space vector here. Curation decides what is worth
 * offering; the database decides what can work. Both must agree.
 *
 * Response: `{ moods: MusicMood[] }`. An empty array is a legitimate answer on
 * an install where the mood-vector task has not run — render no mood row.
 *
 * Artwork: each mood carries `images.primary`, a cover-collage href set built
 * from the albums on that mood's default mood-recommendations page (the SAME
 * cached page the tap then reads, so listing pre-warms it). Absent when the
 * mood has no tracks for this viewer or the page could not be computed —
 * artwork is decoration and never fails the list.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    listMoodKeysWithVectors,
    musicMoodVectorKey,
} from '$lib/server/database/queries/sonic-queue.queries.js';
import { MOOD_CHIPS } from '$lib/constants/music-moods.js';
import { MusicMoodsResponseSchema } from '$lib/schemas/api-music-responses.js';
import { features } from '$lib/server/config.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import {
    getCachedMoodPage,
    DEFAULT_MOOD_PAGE_LIMIT,
} from '$lib/server/services/music/mood-page.service.js';
import { musicCollageImages } from '$lib/server/services/music/collage-images.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('MusicMoodsDef');

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'List selectable moods',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns the moods that can be passed to `music/mood-recommendations` on THIS server, each with a display label and emoji. The set is per-install — mood vectors are generated against the local library — so do NOT hardcode it: an unavailable mood returns an empty track list rather than an error, which is indistinguishable from a mood that simply matched nothing. An empty array means no mood vectors have been generated yet.',
            responses: {
                200: { schema: MusicMoodsResponseSchema, description: 'Available moods' },
                401: 'Authentication required',
                503: 'Database unavailable',
            },
        },
    },

    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const available = new Set(await listMoodKeysWithVectors(sql));

            const chips = MOOD_CHIPS.filter((chip) =>
                available.has(musicMoodVectorKey(chip.genre)),
            );

            // mood-recommendations 404s with sonicQueue off, so there is no
            // page to draw covers from — and nothing a tap would play.
            const coverIds: (string[] | null)[] = features.sonicQueue
                ? await (async () => {
                      const accessCtx = await buildSearchAccessContext(sql, user);
                      return Promise.all(
                          chips.map(async (chip) => {
                              try {
                                  const page = await getCachedMoodPage(
                                      sql,
                                      chip.genre,
                                      DEFAULT_MOOD_PAGE_LIMIT,
                                      accessCtx,
                                  );
                                  return page.rows.map((r) => r.album_id ?? r.id);
                              } catch (err) {
                                  logger.warn('Mood cover page failed', {
                                      mood: chip.genre,
                                      error: (err as Error).message,
                                  });
                                  return null;
                              }
                          }),
                      );
                  })()
                : chips.map(() => null);

            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                [...new Set(coverIds.flatMap((ids) => ids ?? []))].map((id) => ({ id })),
            );
            const moods = chips.map((chip, i) => {
                const images = musicCollageImages(coverIds[i] ?? [], ctx.surface, imageSets);
                return {
                    key: chip.genre,
                    label: chip.label,
                    emoji: chip.emoji,
                    ...(images.primary ? { images } : {}),
                };
            });

            return json(MusicMoodsResponseSchema.parse({ moods }));
        },
    },
});
