// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/music-quick-picks
 *
 * Quick music picks for the user (AI-ranked tracks + recently listened radio).
 *
 * Response: bare object { section: MusicQuickPicksSection | null }
 *
 * When:
 * - No music in library → { section: null }
 * - User has no recent listening → { section: null }
 * - AI DB unavailable → { section: null } (soft dep)
 * - All tracks empty → { section: null }
 *
 * Migrated to new contract:
 * - No success wrapper
 * - images{} hrefs (not flat image/posterUrl)
 * - Fully typed — no z.unknown().passthrough()
 *
 * B-UNTYPED justification: visibility:'internal' BFF endpoint. defineEndpoint has no
 * response slot; response shape is fully typed inline (trackItems/radioItems literals +
 * typed section object) — no z.any()/z.unknown() in the emitted body.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { entityImageUrl } from '$lib/shared/api-urls.js';
import { z } from 'zod';

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(20).optional().default(12),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event, ctx) => {
            const raw = { limit: event.url.searchParams.get('limit') ?? undefined };
            const parsed = QuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const { limit } = parsed.data;

            const { config } = await import('$lib/server/config.js');
            const { getEffectiveUser } = await import('$lib/server/dev-user.js');
            const { aiDbService } = await import('$lib/server/services/database.service.js');

            const effectiveUsername = getEffectiveUser(
                event.request,
                event.locals.user?.username || config.DEFAULT_USER,
            );

            const sql = await aiDbService.getSql();
            if (!sql) return json({ section: null });

            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            const effectiveUserId = await getUserIdByUsername(sql, effectiveUsername);
            if (!effectiveUserId) return json({ section: null });

            const { hasPlayableMusic, hasRecentMusicListening } =
                await import('$lib/server/database/queries/music.queries.js');
            if (!(await hasPlayableMusic(sql))) return json({ section: null });

            const hasListening = await hasRecentMusicListening(sql, effectiveUserId, 14);
            if (!hasListening) return json({ section: null });

            const { buildSearchAccessContext, scopedCacheKey } =
                await import('$lib/server/utils/search-access-context.js');
            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);

            const { getRecentlyListenedRadioMediaItems } =
                await import('$lib/server/database/queries/play-sessions.queries.js');
            const { getQuickPicks } =
                await import('$lib/server/services/music/quick-picks.service.js');
            const { getDislikedTrackIds } =
                await import('$lib/server/database/queries/music-quick-picks.queries.js');
            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');

            type PickedRows = {
                radioRows: Awaited<ReturnType<typeof getRecentlyListenedRadioMediaItems>>;
                tracks: Awaited<ReturnType<typeof getQuickPicks>>;
            };
            const rowCache = cacheManager.for(CACHE_NAMESPACES.musicQuickPicksRow);
            const cacheKey = scopedCacheKey(`${effectiveUserId}:${limit}`, accessCtx);
            const cachedRows = await rowCache.get<PickedRows>(cacheKey);

            let radioRows: PickedRows['radioRows'];
            let tracks: PickedRows['tracks'];
            if (cachedRows) {
                // A cached pick may have been disliked since — drop it rather
                // than wait out the TTL.
                const disliked = new Set(await getDislikedTrackIds(sql, effectiveUserId));
                radioRows = cachedRows.radioRows;
                tracks = cachedRows.tracks.filter((t) => !disliked.has(t.id));
            } else {
                [radioRows, tracks] = await Promise.all([
                    getRecentlyListenedRadioMediaItems(sql, effectiveUserId, 14, 5),
                    getQuickPicks(sql, effectiveUserId, limit, [], {
                        deniedGroupIds: accessCtx.deniedGroupIds,
                        ageRating: accessCtx.ageRating,
                    }),
                ]);
                await rowCache.set(cacheKey, { radioRows, tracks } satisfies PickedRows);
            }

            if (tracks.length === 0) return json({ section: null });

            const { m } = await import('$lib/paraglide/messages.js');

            // UniversalMediaItem shape (PageSectionSchema.items) — the ForYou loader
            // pushes this section straight to UniversalMediaCard, which reads
            // mediaType / image / externalIds. Emitting the API-node shape
            // (type / images.thumb / ids) left every card imageless and hovering
            // them as movies.
            interface QuickPickCardItem {
                id: string;
                externalIds: { internal: string };
                mediaType: 'track';
                title: string;
                subtitle?: string;
                image: string;
                aspectRatio: 'square';
                isAvailable: boolean;
                canRequest: boolean;
                clickData: Record<string, unknown>;
            }

            const trackItems: QuickPickCardItem[] = tracks.map((t) => {
                const row = t as {
                    artist_title?: string | null;
                    artist_id?: string | null;
                    album_id?: string | null;
                };
                return {
                    id: t.id,
                    externalIds: { internal: t.id },
                    mediaType: 'track' as const,
                    title: t.title,
                    subtitle: row.artist_title ?? undefined,
                    // entityImageUrl's 'poster' role parent-walks track → album →
                    // artist for cover art (custom_poster_url); the raw /thumb role
                    // keys off custom_thumb_url, which music never populates.
                    image: entityImageUrl(t.id, 'poster', ctx.surface, { size: 'thumb' }),
                    aspectRatio: 'square' as const,
                    isAvailable: true,
                    canRequest: false,
                    clickData: {
                        ...(t.bucket ? { bucket: t.bucket } : {}),
                        // Clickable artist subtitle + open-album-without-fetch —
                        // same contract as buildQuickPicksSection on /music.
                        ...(row.artist_id ? { artistId: row.artist_id } : {}),
                        ...(row.album_id ? { albumId: row.album_id } : {}),
                    },
                };
            });

            type RadioRow = {
                id: string;
                title: string;
                custom_metadata?: Record<string, unknown> | null;
            };
            const radioItems: QuickPickCardItem[] = (radioRows as RadioRow[]).map((r) => ({
                id: `radio:${r.id}`,
                externalIds: { internal: r.id },
                mediaType: 'track' as const,
                title: r.title,
                image: entityImageUrl(r.id, 'poster', ctx.surface, { size: 'thumb' }),
                aspectRatio: 'square' as const,
                isAvailable: true,
                canRequest: false,
                // Card renders radio-station behaviour when clickData.isRadio is set.
                clickData: { isRadio: true },
            }));

            // Intersperse radio and track items
            function intersperse<T>(tracks: T[], radios: T[]): T[] {
                if (radios.length === 0) return tracks;
                if (tracks.length === 0) return radios;
                const R = radios.length;
                const T2 = tracks.length;
                const total = R + T2;
                const result: T[] = new Array<T>(total);
                const radioPositions = new Set<number>();
                for (let i = 0; i < R; i++) radioPositions.add(Math.floor((i * total) / R));
                let ri = 0;
                let ti = 0;
                for (let pos = 0; pos < total; pos++) {
                    if (radioPositions.has(pos) && ri < R) result[pos] = radios[ri++];
                    else if (ti < T2) result[pos] = tracks[ti++];
                    else result[pos] = radios[ri++];
                }
                return result;
            }

            const items = intersperse(trackItems, radioItems);

            const section = {
                id: 'music-quick-picks',
                type: 'carousel' as const,
                title: m.section_music_quick_picks?.() ?? 'Quick Picks',
                items,
            };

            return json({ section });
        },
    },
});
