// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/series/ordering.ts — `series/{id}/ordering` management.
 *
 * Contract:
 *   GET    /series/{id}/ordering        → { current, available, hasCachedOrderings }
 *   PUT    /series/{id}/ordering        → { orderingType, orderingSource, provider, groupId, updatedAt }
 *   DELETE /series/{id}/ordering        → { message }
 *
 * Auth: GET = user+admin-gated internally; PUT/DELETE = admin.
 * Surface: internal (admin-facing ordering management).
 */

import { mediaIdResolver } from '$lib/server/services/media-id-resolver.js';
import { imageRevision } from '$lib/server/services/image-descriptor/revision.js';
import type { ImageDescriptor } from '$lib/schemas/api-image-descriptor.js';
import { z } from 'zod';
import type postgres from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json, type RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { getEpisodeOrderingService } from '$lib/server/services/episode-ordering.service.js';
import type {
    TMDBEpisodeGroupGroup,
    TMDBEpisodeGroupEpisode,
} from '$lib/server/providers/implementations/tmdb/index.js';
import { parseMediaId, validateParsedMediaId } from '$lib/server/utils/media-key-parser.js';
import { isSeries } from '$lib/server/utils/media-types.js';
import { lookupLegacyJellyfinMediaId } from '$lib/server/utils/media-resolution.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { resolveTmdbIdFromMediaId } from '$lib/server/database/queries/episode-orderings.queries.js';
import { cacheManager } from '$lib/server/cache/index.js';
import { CACHE_NAMESPACES } from '$lib/server/cache/namespaces.js';
import { Logger } from '$lib/server/utils/logger.js';
import { entityImageUrl } from '$lib/shared/api-urls.js';

const logger = Logger.for('CatalogSeriesOrderingDef');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const OrderingCurrentSchema = z.object({
    orderingType: z.string(),
    orderingSource: z.string(),
    provider: z.string().nullable(),
    groupId: z.string().nullable(),
    updatedAt: z.string().optional(),
});

const AvailableOrderingSchema = z.object({
    type: z.string(),
    provider: z.string(),
    groupId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    episodeCount: z.number(),
    groupCount: z.number(),
    providerType: z.number().int().optional(),
});

export const OrderingInfoResponseSchema = z.object({
    current: OrderingCurrentSchema,
    available: z.array(AvailableOrderingSchema),
    hasCachedOrderings: z.boolean(),
});

export const OrderingSetResponseSchema = z.object({
    orderingType: z.string(),
    orderingSource: z.string(),
    provider: z.string().nullable(),
    groupId: z.string().nullable(),
    updatedAt: z.string(),
});

export const OrderingDeleteResponseSchema = z.object({
    message: z.string(),
});

const SetBodySchema = z.object({
    orderingType: z.enum(['absolute', 'dvd', 'standard', 'regional', 'other']),
    provider: z.string().optional(),
    groupId: z.string().optional(),
});

const ApplyBodySchema = z.object({
    provider: z.string().min(1),
    groupId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Helper — parse series id to SeriesIdentifier
// ---------------------------------------------------------------------------

interface ParsedSeriesIdentifier {
    mediaId?: string;
    tmdbId?: number;
    /** A UUID-shaped id that may be a legacy Jellyfin series id from an older client. */
    legacyJellyfinId?: string;
}

async function resolveSeriesIdentifier(id: string): Promise<ParsedSeriesIdentifier | null> {
    const parsed = parseMediaId(id);
    if (!validateParsedMediaId(parsed)) return null;
    if (parsed.type === 'composite' && !isSeries(parsed.mediaType)) return null;
    if (parsed.type === 'uuid' && parsed.uuid) {
        return { mediaId: parsed.uuid, legacyJellyfinId: parsed.uuid };
    }
    if (parsed.type === 'composite' && parsed.provider === 'tmdb' && parsed.externalId) {
        const tmdbId = parseInt(parsed.externalId, 10);
        if (!isNaN(tmdbId)) return { tmdbId };
    }
    if (parsed.type === 'composite' && parsed.provider === 'jellyfin' && parsed.externalId) {
        return { legacyJellyfinId: parsed.externalId };
    }
    try {
        const resolved = await mediaIdResolver.resolveAnyMediaId(id);
        return resolved.internalId && isSeries(resolved.mediaType)
            ? { mediaId: resolved.internalId }
            : null;
    } catch {
        return null;
    }
}

/**
 * Map a legacy Jellyfin series id (bare or `jellyfin:<id>:tv`) to the internal
 * id through the rows Jellyfin sync keeps; lookup only. A bare id that maps to
 * nothing stays as given (an internal UUID); a `jellyfin:` key that maps to
 * nothing is null (not found).
 */
async function mapLegacySeriesIdentifier(
    sql: postgres.Sql,
    ident: ParsedSeriesIdentifier,
): Promise<{ mediaId?: string; tmdbId?: number } | null> {
    if (!ident.legacyJellyfinId) {
        return ident.tmdbId !== undefined ? { tmdbId: ident.tmdbId } : { mediaId: ident.mediaId };
    }
    const mapped = await lookupLegacyJellyfinMediaId(sql, ident.legacyJellyfinId);
    if (mapped) return { mediaId: mapped };
    return ident.mediaId ? { mediaId: ident.mediaId } : null;
}

/**
 * The series' own TMDB season sizes, for the ordering preview. A group lists
 * only the episodes it reorders, so without these the preview cannot say how
 * many episodes of a season the group leaves out. Best-effort: any failure
 * (unknown series, no access, TMDB down) returns undefined and the preview
 * shows the group's numbers alone, as before.
 */
async function previewSeasonTotals(
    event: RequestEvent,
): Promise<Array<{ seasonNumber: number; episodeCount: number }> | undefined> {
    try {
        const id = event.params.id;
        const sql = getDb();
        if (!id || !sql) return undefined;
        const parsed = await resolveSeriesIdentifier(id);
        if (!parsed) return undefined;
        const seriesId = await mapLegacySeriesIdentifier(sql, parsed);
        if (!seriesId) return undefined;

        let tmdbId = seriesId.tmdbId ?? null;
        if (seriesId.mediaId) {
            if (!(await checkMediaAccess(sql, seriesId.mediaId, event.locals.user))) {
                return undefined;
            }
            tmdbId = await resolveTmdbIdFromMediaId(sql, seriesId.mediaId);
        } else if (event.locals.user?.isAgeRestricted) {
            return undefined;
        }
        if (!tmdbId) return undefined;

        const { tmdbApi } = await import('$lib/server/providers/implementations/tmdb/index.js');
        const seasons = await tmdbApi.getTVShowSeasons(tmdbId);
        if (seasons.length === 0) return undefined;
        return seasons.map((s) => ({ seasonNumber: s.seasonNumber, episodeCount: s.episodeCount }));
    } catch (e) {
        logger.warn('Ordering preview: season totals unavailable', {
            error: e instanceof Error ? e.message : String(e),
        });
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: {
        GET: { kind: 'user' },
        PUT: { kind: 'admin' },
        DELETE: { kind: 'admin' },
    },
    visibility: 'internal',

    // No def-level `request.body`: mount() applies a declared body schema to
    // every method that can carry one, including DELETE (see mount.ts
    // `methodCanHaveBody`). `SetBodySchema` has a required `orderingType`
    // field, so declaring it here would reject every DELETE (empty body)
    // before this handler ever runs. PUT validates the body itself instead.
    handlers: {
        GET: async (event, _ctx) => {
            const { id } = event.params;
            if (!id)
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Series ID is required' },
                ]);

            const parsedSeriesId = await resolveSeriesIdentifier(id);
            if (!parsedSeriesId) {
                return ApiProblem.validationFailed([
                    {
                        field: 'id',
                        message:
                            'Invalid series ID. Must be UUID or full composite key (tmdb:1429:tv)',
                    },
                ]);
            }
            if (
                !parsedSeriesId.mediaId &&
                !parsedSeriesId.tmdbId &&
                !parsedSeriesId.legacyJellyfinId
            ) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Invalid series ID format' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');
            const seriesId = await mapLegacySeriesIdentifier(sql, parsedSeriesId);
            if (!seriesId) return ApiProblem.notFound('Series not found');

            // Library + age gate
            if (seriesId.mediaId) {
                if (!(await checkMediaAccess(sql, seriesId.mediaId, event.locals.user))) {
                    return ApiProblem.notFound('Series not found');
                }
            } else if (event.locals.user?.isAgeRestricted) {
                return ApiProblem.notFound('Series not found');
            }

            const service = getEpisodeOrderingService(sql);
            const currentOrdering = await service.getSeriesOrdering(seriesId);
            const availableOrderings = await service.getAvailableOrderings(seriesId);
            const hasCachedOrderings = await service.hasOrderingsCache(seriesId);

            const body: z.infer<typeof OrderingInfoResponseSchema> = {
                current: currentOrdering
                    ? {
                          orderingType: currentOrdering.orderingType,
                          orderingSource: currentOrdering.orderingSource,
                          provider: currentOrdering.orderingProvider,
                          groupId: currentOrdering.orderingGroupId,
                          updatedAt: currentOrdering.updatedAt.toISOString(),
                      }
                    : {
                          orderingType: 'standard',
                          orderingSource: 'default',
                          provider: null,
                          groupId: null,
                      },
                available: (availableOrderings as z.infer<typeof AvailableOrderingSchema>[]) ?? [],
                hasCachedOrderings,
            };

            return json(body);
        },

        PUT: async (event) => {
            const { id } = event.params;
            if (!id)
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Series ID is required' },
                ]);

            const parsedSeriesId = await resolveSeriesIdentifier(id);
            if (
                !parsedSeriesId ||
                (!parsedSeriesId.mediaId &&
                    !parsedSeriesId.tmdbId &&
                    !parsedSeriesId.legacyJellyfinId)
            ) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Invalid series ID format' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');
            const seriesId = await mapLegacySeriesIdentifier(sql, parsedSeriesId);
            if (!seriesId) return ApiProblem.notFound('Series not found');

            let rawBody: unknown;
            try {
                rawBody = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsedBody = SetBodySchema.safeParse(rawBody);
            if (!parsedBody.success) {
                return ApiProblem.validationFailed(
                    parsedBody.error.issues.map((issue) => ({
                        field: issue.path.join('.'),
                        message: issue.message,
                    })),
                );
            }
            const { provider, groupId } = parsedBody.data;
            // Older clients may still label original-air-date groups as standard.
            // Keep explicit groups applicable without changing legacy rows on read.
            const orderingType =
                parsedBody.data.orderingType === 'standard' && provider && groupId
                    ? 'other'
                    : parsedBody.data.orderingType;

            if (orderingType !== 'standard' && (!provider || !groupId)) {
                return ApiProblem.validationFailed([
                    {
                        field: 'body',
                        message: 'provider and groupId are required for non-standard orderings',
                    },
                ]);
            }

            const service = getEpisodeOrderingService(sql);
            const result = await service.setSeriesOrdering(seriesId, orderingType, {
                source: 'manual',
                provider: provider ?? undefined,
                groupId: groupId ?? undefined,
            });

            if (orderingType !== 'standard' && provider && groupId) {
                try {
                    const syncedCount = await service.syncOrderings(
                        seriesId,
                        orderingType,
                        provider,
                        groupId,
                        { force: true },
                    );
                    logger.info('Synced orderings after preference change', {
                        seriesId,
                        orderingType,
                        provider,
                        syncedCount,
                    });
                } catch (e) {
                    logger.warn('Failed to sync orderings', {
                        seriesId,
                        orderingType,
                        provider,
                        error: e,
                    });
                }
            }

            return json({
                orderingType: result.orderingType,
                orderingSource: result.orderingSource,
                provider: result.orderingProvider,
                groupId: result.orderingGroupId,
                updatedAt: result.updatedAt.toISOString(),
            } satisfies z.infer<typeof OrderingSetResponseSchema>);
        },

        DELETE: async (event, _ctx) => {
            const { id } = event.params;
            if (!id)
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Series ID is required' },
                ]);

            const parsedSeriesId = await resolveSeriesIdentifier(id);
            if (
                !parsedSeriesId ||
                (!parsedSeriesId.mediaId &&
                    !parsedSeriesId.tmdbId &&
                    !parsedSeriesId.legacyJellyfinId)
            ) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Invalid series ID format' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');
            const seriesId = await mapLegacySeriesIdentifier(sql, parsedSeriesId);
            if (!seriesId) return ApiProblem.notFound('Series not found');

            const service = getEpisodeOrderingService(sql);
            await service.resetSeriesOrdering(seriesId);

            return json({ message: 'Series ordering reset to standard' } satisfies z.infer<
                typeof OrderingDeleteResponseSchema
            >);
        },
    },
});

// ---------------------------------------------------------------------------
// Apply sub-route def (POST /series/{id}/ordering/apply)
// ---------------------------------------------------------------------------

export const applyDef = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',

    request: {
        body: ApplyBodySchema,
    },

    handlers: {
        POST: async (event, ctx) => {
            const { id } = event.params;
            if (!id)
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Series ID is required' },
                ]);

            const parsedSeriesId = await resolveSeriesIdentifier(id);
            if (
                !parsedSeriesId ||
                (!parsedSeriesId.mediaId &&
                    !parsedSeriesId.tmdbId &&
                    !parsedSeriesId.legacyJellyfinId)
            ) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Invalid series ID format' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');
            const seriesId = await mapLegacySeriesIdentifier(sql, parsedSeriesId);
            if (!seriesId) return ApiProblem.notFound('Series not found');

            const { provider, groupId } = ctx.input!.body;

            const service = getEpisodeOrderingService(sql);
            const ordering = await service.getSeriesOrdering(seriesId);
            if (!ordering || ordering.orderingType === 'standard') {
                return ApiProblem.validationFailed([
                    {
                        field: 'body',
                        message:
                            'No non-standard ordering is set for this series. Use PUT /ordering first.',
                    },
                ]);
            }

            const result = await service.applyOrderingToEpisodes(
                seriesId,
                ordering.orderingType,
                provider,
                groupId,
            );

            logger.info('Episode ordering applied via API', {
                seriesId: id,
                provider,
                groupId,
                applied: result.applied,
                skipped: result.skipped,
            });

            if (result.applied > 0) {
                try {
                    const nextEpCache = cacheManager.for(CACHE_NAMESPACES.nextEpisode);
                    const newEpCache = cacheManager.for(CACHE_NAMESPACES.newEpisodes);
                    await Promise.all([nextEpCache.clear(), newEpCache.clear()]);
                } catch {
                    logger.warn('Failed to clear caches after ordering apply');
                }
            }

            return json({
                applied: result.applied,
                skipped: result.skipped,
                combined: result.combined,
            });
        },
    },
});

// ---------------------------------------------------------------------------
// Auto-fix sub-route def (POST /series/{id}/ordering/auto-fix)
//
// Detects a TVDB-vs-TMDB season-structure mismatch (file-backed episodes with
// no TMDB identity) and resolves it via a structurally matching episode group:
// binds identity onto the file rows, deletes ghost duplicates, activates the
// group as the series ordering. dryRun returns the detection without applying.
// ---------------------------------------------------------------------------

const AutoFixBodySchema = z.object({
    dryRun: z.boolean().optional(),
});

export const autoFixDef = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',

    request: {
        body: AutoFixBodySchema,
    },

    handlers: {
        POST: async (event, ctx) => {
            const { id } = event.params;
            if (!id)
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Series ID is required' },
                ]);

            const parsedSeriesId = await resolveSeriesIdentifier(id);
            if (!parsedSeriesId?.mediaId) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Series ID must be an internal UUID for auto-fix' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');
            const seriesId = await mapLegacySeriesIdentifier(sql, parsedSeriesId);
            if (!seriesId?.mediaId) return ApiProblem.notFound('Series not found');

            const { detectSeasonStructureFix, applySeasonStructureFix } =
                await import('$lib/server/services/season-structure-reconciliation.service.js');

            const detection = await detectSeasonStructureFix(sql, seriesId.mediaId);
            if (!detection) {
                return json({ detected: false });
            }

            const detectionSummary = {
                detected: true,
                provider: detection.provider,
                groupId: detection.groupId,
                groupName: detection.groupName,
                orderingType: detection.orderingType,
                bindings: detection.bindings.length,
                relocations: detection.relocations.length,
                agreements: detection.agreements,
                exactStructure: detection.exactStructure,
            };

            if (ctx.input?.body?.dryRun) {
                return json({ ...detectionSummary, dryRun: true });
            }

            const result = await applySeasonStructureFix(sql, detection);
            logger.info('Season-structure auto-fix applied via API', {
                seriesId: seriesId.mediaId,
                ...detectionSummary,
                ...result,
            });
            return json({ ...detectionSummary, ...result });
        },
    },
});

// ---------------------------------------------------------------------------
// Sync sub-route def (POST /series/{id}/ordering/sync)
// ---------------------------------------------------------------------------

const SyncBodySchema = z.object({
    orderingType: SetBodySchema.shape.orderingType.optional(),
    provider: z.string().optional(),
    groupId: z.string().optional(),
});

export const syncDef = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',

    request: {
        body: SyncBodySchema,
        query: z.object({ orderingType: SetBodySchema.shape.orderingType.optional() }),
    },

    handlers: {
        POST: async (event, ctx) => {
            const { id } = event.params;
            if (!id)
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Series ID is required' },
                ]);

            const parsedSeriesId = await resolveSeriesIdentifier(id);
            if (
                !parsedSeriesId ||
                (!parsedSeriesId.mediaId &&
                    !parsedSeriesId.tmdbId &&
                    !parsedSeriesId.legacyJellyfinId)
            ) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Invalid series ID format' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');
            const seriesId = await mapLegacySeriesIdentifier(sql, parsedSeriesId);
            if (!seriesId) return ApiProblem.notFound('Series not found');

            const body = ctx.input!.body;
            const orderingType = body?.orderingType ?? ctx.input!.query?.orderingType;
            const provider = body?.provider ?? event.url.searchParams.get('provider') ?? undefined;
            const groupId = body?.groupId ?? event.url.searchParams.get('groupId') ?? undefined;

            const service = getEpisodeOrderingService(sql);

            if (orderingType && provider && groupId) {
                const count = await service.syncOrderings(
                    seriesId,
                    orderingType,
                    provider,
                    groupId,
                    { force: true },
                );
                logger.info('Synced specific ordering', {
                    seriesId,
                    orderingType,
                    provider,
                    groupId,
                    count,
                });
                return json({ synced: [{ type: orderingType, provider, count }] });
            }

            const results = await service.syncAllOrderings(seriesId);
            logger.info('Synced all orderings', { seriesId, results });
            return json({ synced: results });
        },
    },
});

// ---------------------------------------------------------------------------
// Preview sub-route def (GET /series/{id}/ordering/preview)
// ---------------------------------------------------------------------------

export const previewDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    handlers: {
        GET: async (event, ctx) => {
            const groupId = event.url.searchParams.get('groupId');
            const provider = event.url.searchParams.get('provider');

            if (!groupId || !provider) {
                return ApiProblem.validationFailed([
                    {
                        field: 'query',
                        message: 'groupId and provider query parameters are required',
                    },
                ]);
            }

            if (provider !== 'tmdb') {
                return ApiProblem.validationFailed([
                    {
                        field: 'query.provider',
                        message: `Ordering preview not yet supported for provider: ${provider}`,
                    },
                ]);
            }

            const { tmdbApi, TMDBApiService } =
                await import('$lib/server/providers/implementations/tmdb/index.js');

            if (!tmdbApi.isAvailable()) {
                return ApiProblem.dependencyUnavailable('TMDB API is not configured');
            }

            const details = await tmdbApi.getEpisodeGroupDetails(groupId);
            if (!details) {
                return ApiProblem.notFound('Episode group not found');
            }

            // Build preview (logic preserved from legacy handler)
            const orderingType = TMDBApiService.mapEpisodeGroupType(details.type);
            const sortedGroups = [...details.groups].sort(
                (a: TMDBEpisodeGroupGroup, b: TMDBEpisodeGroupGroup) => a.order - b.order,
            );

            const padN = (n: number) => String(n).padStart(2, '0');
            const fmtSE = (s: number, e: number) => `S${padN(s)}E${padN(e)}`;

            let absoluteCounter = 0;
            const groups = sortedGroups.map((group: TMDBEpisodeGroupGroup, groupIdx: number) => {
                const sortedEps = [...group.episodes].sort(
                    (a: TMDBEpisodeGroupEpisode, b: TMDBEpisodeGroupEpisode) => a.order - b.order,
                );
                const episodeCount = sortedEps.length;
                const displaySeason = groupIdx + 1;
                const absoluteStart = absoluteCounter + 1;
                absoluteCounter += episodeCount;
                const absoluteEnd = absoluteCounter;

                const firstEp = sortedEps[0];
                const lastEp = sortedEps[sortedEps.length - 1];
                const originalRange =
                    firstEp && lastEp
                        ? firstEp.season_number === lastEp.season_number
                            ? `S${padN(firstEp.season_number)}E${padN(firstEp.episode_number)}–E${padN(lastEp.episode_number)}`
                            : `${fmtSE(firstEp.season_number, firstEp.episode_number)}–${fmtSE(lastEp.season_number, lastEp.episode_number)}`
                        : '?';

                let displayRange: string;
                if (orderingType === 'absolute') {
                    displayRange =
                        absoluteStart === absoluteEnd
                            ? `#${absoluteStart}`
                            : `#${absoluteStart}–#${absoluteEnd}`;
                } else {
                    displayRange =
                        episodeCount === 1
                            ? `S${padN(displaySeason)}E01`
                            : `S${padN(displaySeason)}E01–S${padN(displaySeason)}E${padN(episodeCount)}`;
                }

                const displayLabel = group.name
                    ? group.name
                    : orderingType === 'absolute'
                      ? `Group ${displaySeason}`
                      : `Season ${displaySeason}`;

                let thumb: ImageDescriptor | undefined;
                if (firstEp?.still_path) {
                    const revision = imageRevision({
                        ownerId: `tmdb:${firstEp.id}:episode`,
                        role: 'thumb',
                        providerPath: firstEp.still_path,
                    });
                    const variants = Object.fromEntries(
                        (['thumb', 'card', 'full'] as const).map((size) => [
                            size,
                            `${entityImageUrl(`tmdb:${firstEp.id}:episode`, 'still', ctx.surface, {
                                size,
                                path: firstEp.still_path,
                            })}&v=${revision}`,
                        ]),
                    );
                    thumb = { href: variants.card, variants, revision, source: 'provider' };
                }

                return {
                    displayLabel,
                    episodeCount,
                    originalRange,
                    displayRange,
                    images: thumb ? { thumb } : {},
                };
            });

            const episodes: Array<{
                originalSeason: number;
                originalEpisode: number;
                name: string;
                newGroupIndex: number;
                newPositionInGroup: number;
                absoluteNumber: number | null;
            }> = [];
            let absCounter = 0;

            for (let groupIdx = 0; groupIdx < sortedGroups.length; groupIdx++) {
                const group = sortedGroups[groupIdx];
                const sortedEps = [...group.episodes].sort(
                    (a: TMDBEpisodeGroupEpisode, b: TMDBEpisodeGroupEpisode) => a.order - b.order,
                );
                for (let posInGroup = 0; posInGroup < sortedEps.length; posInGroup++) {
                    const ep = sortedEps[posInGroup];
                    absCounter++;
                    episodes.push({
                        originalSeason: ep.season_number,
                        originalEpisode: ep.episode_number,
                        name: ep.name ?? `Episode ${ep.episode_number}`,
                        newGroupIndex: groupIdx,
                        newPositionInGroup: posInGroup,
                        absoluteNumber: orderingType === 'absolute' ? absCounter : null,
                    });
                }
            }

            const seasonTotals = await previewSeasonTotals(event);

            return json({
                name: details.name,
                type: orderingType,
                providerType: details.type,
                totalEpisodes: details.episode_count,
                groups,
                episodes,
                ...(seasonTotals ? { seasonTotals } : {}),
            });
        },
    },
});
