// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/watching
 *
 * Server-Driven UI watching sections (Continue Watching, Next Up).
 * Returns a bare object { sections: WatchingSection[] }.
 *
 * This endpoint returns SDUI sections (not a paginated collection) because it
 * is a carousel compositor, not a flat list. It remains internal and is NOT
 * published to /api/v1 — the Tier-2 surface for watching data is
 * /api/v1/continue-watching (continue-watching.ts def).
 *
 * Response: { sections: WatchingSection[] }  (bare object, no success wrapper)
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import type { UserId } from '$lib/shared/user-id.js';

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).optional().default(10),
    mergeSort: z
        .string()
        .optional()
        .transform((v) => v === 'true'),
    includeNewEpisodes: z
        .string()
        .optional()
        .transform((v) => v === 'true'),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event) => {
            if (event.locals.user?.isAgeRestricted) return json({ sections: [] });

            const raw = {
                limit: event.url.searchParams.get('limit') ?? undefined,
                mergeSort: event.url.searchParams.get('mergeSort') ?? undefined,
                includeNewEpisodes: event.url.searchParams.get('includeNewEpisodes') ?? undefined,
            };
            const parsed = QuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const { limit, mergeSort, includeNewEpisodes } = parsed.data;

            const { config } = await import('$lib/server/config.js');
            const { getEffectiveUser } = await import('$lib/server/dev-user.js');
            const { getDb } = await import('$lib/server/database/index.js');
            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            const { effectiveWatchingFor } =
                await import('$lib/server/services/effective-watching.service.js');
            const { buildSearchAccessContext } =
                await import('$lib/server/utils/search-access-context.js');

            const username = getEffectiveUser(
                event.request,
                event.locals.user?.username || config.DEFAULT_USER,
            );

            let effectiveUserId: UserId | undefined;
            const sqlForAccess = getDb();
            if (username === event.locals.user?.username) {
                effectiveUserId = event.locals.user?.userId;
            } else {
                if (!sqlForAccess)
                    return ApiProblem.dependencyUnavailable('Database not available');
                effectiveUserId = (await getUserIdByUsername(sqlForAccess, username)) ?? undefined;
            }
            if (!effectiveUserId) return json({ sections: [] });

            const accessCtx = sqlForAccess
                ? await buildSearchAccessContext(sqlForAccess, event.locals.user)
                : null;

            const { continueWatching, nextUp } = await effectiveWatchingFor({
                username,
                userId: effectiveUserId,
                limit,
                mergeSort,
                includeNewEpisodes,
                access: accessCtx
                    ? { deniedGroupIds: accessCtx.deniedGroupIds, ageRating: accessCtx.ageRating }
                    : undefined,
            });

            // Reuse the SAME transform the SSR first-paint path uses
            // (+page.server.ts → buildWatchingSections) so the client-refresh
            // response is byte-for-byte the same schema-valid UniversalMediaItem
            // shape (flat `image`, `isAvailable`, `canRequest`, `mediaType`). The
            // previous hand-rolled mapping emitted a bespoke shape (type
            // 'movie-or-series', nested images{}, no availability), which failed the
            // client UniversalMediaItemSchema → apiFetch fail-opened → the card
            // rendered blank posters + a "+"/request affordance on library items.
            const { buildWatchingSections } = await import('$lib/server/utils/section-builder.js');
            const { stripAudiobookListArraysFromSections } =
                await import('$lib/server/utils/strip-audiobook-list-arrays.js');
            // Chapter/file lists are stripped here — a single in-progress
            // audiobook can carry hundreds of entries in each array and no
            // rail card renders them (see stripAudiobookListArraysFromSections).
            const sections = stripAudiobookListArraysFromSections(
                buildWatchingSections({ continueWatching, nextUp }),
            );

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): resolved once per request. This endpoint computes fresh on every
            // call (no cache), so there is no ordering hazard — still applied as
            // the very last step before the response is built.
            const overlayUserId = event.locals.user?.userId;
            if (overlayUserId && sqlForAccess && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                const { resolveMetadataLanguage } =
                    await import('$lib/server/utils/metadata-language-resolve.js');
                const { getPlaybackPreferences } =
                    await import('$lib/server/database/queries/user-preferences.queries.js');
                const langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(sqlForAccess, { userId: overlayUserId }),
                );
                if (langs.titleLang || langs.textLang) {
                    const { applyTranslationOverlay } =
                        await import('$lib/server/utils/translation-overlay.js');
                    const { UUID_RE } = await import('$lib/utils/id-patterns.js');
                    const allItems = sections.flatMap((s) => s.items ?? []);
                    await applyTranslationOverlay(sqlForAccess, allItems, langs, {
                        id: (it) => (it.id && UUID_RE.test(it.id) ? it.id : null),
                        setTitle: (it, v) => {
                            it.title = v;
                        },
                        setOverview: (it, v) => {
                            it.overview = v;
                        },
                    });
                }
            }

            return json({ sections });
        },
    },
});
