// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/music-because
 *
 * "Because you listened to X" music recommendations.
 * Per-user + access-scoped cache (5min L1 / 1hr L2) via aiSuggestions namespace.
 *
 * Response: bare object { section: PageSection | null }
 *
 * Contract (matches the client MusicSectionResponseSchema → PageSectionSchema):
 * - No success wrapper
 * - items are UniversalMediaItem (mediaType:'track', flat `image`,
 *   `externalIds.internal`) — the shape UniversalMediaCard renders. The older
 *   API-node shape (type/images.thumb/ids) failed PageSectionSchema and left
 *   cards imageless; this mirrors the music-quick-picks fix.
 * - AI DB unavailable → { section: null } (soft dep, not 503)
 * - Fully typed response — no z.unknown().passthrough()
 *
 * B-UNTYPED justification: visibility:'internal' BFF endpoint. defineEndpoint has no
 * response slot; response is validated at runtime against the shared
 * PageSectionSchema via .parse() — no z.any()/z.unknown() in the emitted body.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { entityImageUrl, type ApiSurface } from '$lib/shared/api-urls.js';
import { PageSectionSchema } from '$lib/schemas/api-responses.js';

const QuerySchema = z.object({
    nocache: z
        .string()
        .optional()
        .transform((v) => v === '1'),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event, ctx) => {
            const raw = { nocache: event.url.searchParams.get('nocache') ?? undefined };
            const parsed = QuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const { nocache } = parsed.data;

            const { config } = await import('$lib/server/config.js');
            const { getEffectiveUser } = await import('$lib/server/dev-user.js');
            const { aiDbService } = await import('$lib/server/services/database.service.js');
            const { fetchMusicRecommendations } =
                await import('$lib/server/services/for-you.service.js');
            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            const { buildSearchAccessContext, scopedCacheKey, searchAccessBoundary } =
                await import('$lib/server/utils/search-access-context.js');
            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');

            const effectiveUsername = getEffectiveUser(
                event.request,
                event.locals.user?.username || config.DEFAULT_USER,
            );

            const sql = await aiDbService.getSql();
            if (!sql) {
                // AI DB is a soft dependency for music recommendations
                return json({ section: null });
            }

            const effectiveUserId = await getUserIdByUsername(sql, effectiveUsername);
            if (!effectiveUserId) {
                return json({ section: null });
            }

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const cacheKey = scopedCacheKey(`music-because:${effectiveUserId}`, accessCtx);
            const musicBecauseCache = cacheManager.for(CACHE_NAMESPACES.aiSuggestions);

            type RawSection = Awaited<ReturnType<typeof fetchMusicRecommendations>>;

            if (!nocache) {
                const cached = await musicBecauseCache.get<{ section: RawSection }>(cacheKey);
                if (cached) {
                    const cachedSection = cached.section
                        ? PageSectionSchema.parse(canonicalizeSection(cached.section, ctx.surface))
                        : null;
                    return json({ section: cachedSection });
                }
            }

            const rawSection = await fetchMusicRecommendations(
                sql,
                effectiveUserId,
                searchAccessBoundary(accessCtx),
            );

            await musicBecauseCache.set(cacheKey, { section: rawSection ?? null });

            const section = rawSection
                ? PageSectionSchema.parse(canonicalizeSection(rawSection, ctx.surface))
                : null;
            return json({ section });
        },
    },
});

/**
 * Map a raw fetchMusicRecommendations section to the canonical PageSection
 * contract — the SAME UniversalMediaItem shape the ForYou loader pushes
 * straight to UniversalMediaCard (which reads `mediaType` / `image` /
 * `externalIds`). The earlier API-node shape (`type` / `images.thumb` / `ids`)
 * failed PageSectionSchema and left every card imageless, mirroring the
 * music-quick-picks fix.
 */
function canonicalizeSection(
    rawSection: {
        id?: string;
        title?: string;
        type?: string;
        seedTrack?: { id?: string; title?: string; artist?: string } | null;
        items?: Array<{
            id?: string;
            title?: string;
            artist_title?: string;
            image?: string;
            externalIds?: Record<string, string | null | undefined>;
        }>;
    },
    surface: ApiSurface,
) {
    return {
        id: 'music-because' as const,
        type: 'carousel' as const,
        title: rawSection.title ?? 'Because you listened to…',
        ...(rawSection.seedTrack?.title
            ? { meta: { sourceTitle: rawSection.seedTrack.title } }
            : {}),
        items: (rawSection.items ?? [])
            .map((item) => {
                const internalId =
                    item.id ??
                    (item.externalIds ? getExternalIdFor(item.externalIds, 'internal') : undefined);
                return { item, internalId };
            })
            // A track with no resolvable internal id can't produce a catalog
            // image or a valid detail link — drop it rather than emit a
            // degenerate card (empty id + empty image).
            .filter((entry): entry is { item: (typeof entry)['item']; internalId: string } =>
                Boolean(entry.internalId),
            )
            .map(({ item, internalId }) => ({
                id: internalId,
                externalIds: { internal: internalId },
                mediaType: 'track' as const,
                title: item.title ?? '',
                ...(item.artist_title ? { subtitle: item.artist_title } : {}),
                // entityImageUrl's 'poster' role parent-walks track → album → artist
                // for cover art (custom_poster_url); the raw /thumb role keys off
                // custom_thumb_url, which music never populates.
                image: entityImageUrl(internalId, 'poster', surface, { size: 'thumb' }),
                aspectRatio: 'square' as const,
                isAvailable: true,
                canRequest: false,
            })),
    };
}
