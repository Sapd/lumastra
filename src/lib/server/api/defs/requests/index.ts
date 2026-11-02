// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/requests/index.ts — POST /requests (create) + GET /requests (list/batch)
 *
 * POST /requests
 *   Auth: user + hasRequestPermission (enforced server-side). Rate-limited 20/60. 201 + Location.
 *
 * GET /requests?scope=mine|all&status=&ids=&externalId=
 *   scope=mine (default): caller's own requests — any authenticated user.
 *   scope=all: all requests — requires `requests:admin` scope.
 *
 *   Batch-fetch (short-circuits scope/status):
 *   ids=1,2,3           — fetch up to 50 requests by Jellyseerr ID.
 *   externalId=tmdb:550 — fetch requests matching an external ID.
 *
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { jellyseerrClient, type JellyseerrRequest } from '$lib/server/jellyseerr.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { getClientIp } from '$lib/server/utils/client-ip.js';
import { requestManager } from '$lib/server/services/request-manager.service.js';
import { createOutcomeToProblem, requestPermissionProblem } from './create-problem.js';
import {
    getDismissalsForUser,
    getSimpleStatusLabel,
} from '$lib/server/services/request-status/index.js';
import { filterOrphanedRequests } from '$lib/server/services/request-status/orphan-filter.js';
import { filterRequestsWithoutCatalogMatch } from '$lib/server/services/request-status/catalog-match-filter.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import { apiUrl } from '$lib/shared/api-urls.js';
import { buildRequestDismissalExtKey } from '$lib/shared/request-dismissal-key.js';
import { hasRequestsAdmin } from './requests-admin.js';

const RequestItemSchema = z.object({
    id: z.number().int(),
    dismissalKey: z.string(),
    externalIds: z.record(z.string(), z.string()),
    mediaType: z.enum(['movie', 'series']),
    title: z.string(),
    posterPath: z.string().nullable(),
    status: z.string(),
    requestedAt: z.string().meta({ description: 'ISO-8601 creation timestamp' }),
    is4k: z.boolean(),
    seasons: z.array(z.number().int()).optional(),
});

const RequestsListResponseSchema = z.object({
    items: z.array(RequestItemSchema),
    page: z.object({
        limit: z.number().int(),
        offset: z.number().int(),
        hasMore: z.boolean(),
    }),
    linked: z
        .boolean()
        .optional()
        .meta({ description: 'Whether the user has a Jellyseerr account linked' }),
    dismissals: z.array(z.object({ key: z.string(), dismissedAt: z.string() })),
});

const CreateRequestBodySchemaFromDocs = z.object({
    externalIds: z
        .record(z.string(), z.string())
        .meta({ description: 'At least one external ID is required (e.g. { "tmdb": "603" })' }),
    mediaType: z.enum(['movie', 'series']).meta({
        description: 'Media type: movie or series.',
    }),
    seasons: z
        .array(z.number().int().min(1))
        .optional()
        .meta({ description: 'Season numbers to request (TV series only)' }),
});

const CreateRequestResponseSchema = z.object({
    id: z.number().int().meta({ description: 'Jellyseerr request ID' }),
    requestedAt: z.string().meta({ description: 'ISO-8601 creation timestamp' }),
});

/** Jellyseerr request type → public discriminator. Only movie/series are
 * renderable request rows; anything else → null (row dropped). */
function toRequestType(type: string): 'movie' | 'series' | null {
    const p = toPublicMediaType(type);
    return p === 'movie' || p === 'series' ? p : null;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Body schema for POST /requests.
 *
 * `mediaType` accepts only `movie` and `series`,
 * normalising to `tv` internally since Jellyseerr still expects `tv`.
 * The public API contract uses `series` as the discriminator value.
 *
 * Lenient: unknown fields are stripped (no .strict()).
 */
const CreateRequestBodySchema = z.object({
    externalIds: z
        .record(z.string(), z.string())
        .refine((ids) => Object.values(ids).some((v) => typeof v === 'string' && v.length > 0), {
            message: 'At least one external ID is required',
        }),
    /** Canonical: `movie` or `series`.  Storage conversion happens after validation. */
    mediaType: z
        .enum(['movie', 'series'])
        // constrained: the enum above admits only movie|series|tv and the
        // transform maps 'series' away, so only 'movie'|'tv' can reach here.
        // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
        .transform((v) => (v === 'series' ? 'tv' : v) as 'movie' | 'tv'),
    seasons: z
        .array(z.number().int().min(1))
        .max(50)
        .transform((arr) => [...new Set(arr)])
        .optional(),
});

/**
 * Query schema for GET /requests.
 *
 * Lenient: unknown params are stripped. All values arrive as strings —
 * no coercion needed here (handler reads them directly from searchParams).
 */
const GetRequestsQuerySchema = z.object({
    /** Visibility: 'mine' (default) or 'all'. */
    scope: z.enum(['mine', 'all']).optional(),
    /** Status filter: 'pending' (default) | 'approved' | 'declined' | 'all'. */
    status: z.enum(['pending', 'approved', 'declined', 'all']).optional(),
    /** Batch-fetch: comma-separated Jellyseerr request IDs (1–50). */
    ids: z.string().optional(),
    /** Batch-fetch: single external ID in provider:value format (e.g. tmdb:550). */
    externalId: z.string().optional(),
    /** Disambiguates `externalId` — TMDB IDs are not unique across media types. */
    mediaType: z.enum(['movie', 'series']).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Page through Jellyseerr's request list instead of truncating at a single
 * `take`.
 *
 * The `?externalId=` lookup filters by TMDB ID *after* fetching, so a fixed
 * `take: 100` silently answered "not requested" for any user whose match sat
 * past the first page. Bounded at MAX_PAGES so a large instance cannot turn one
 * lookup into an unbounded fan-out; on hitting the bound we stop, which is the
 * same (rare) truncation as before rather than a regression.
 */
const REQUEST_PAGE_SIZE = 100;
const MAX_REQUEST_PAGES = 10;

async function fetchAllRequests(options: {
    status: 'approved' | 'pending' | 'declined' | 'all';
    requestedBy?: number;
}): Promise<JellyseerrRequest[]> {
    const all: JellyseerrRequest[] = [];
    for (let page = 0; page < MAX_REQUEST_PAGES; page++) {
        const batch = await jellyseerrClient.getRequests({
            ...options,
            take: REQUEST_PAGE_SIZE,
            skip: page * REQUEST_PAGE_SIZE,
        });
        all.push(...batch);
        if (batch.length < REQUEST_PAGE_SIZE) break;
    }
    return all;
}

/** Fetch title from Jellyseerr media info when it is not embedded in the request. */
async function getTitleFromJellyseerr(
    tmdbId: number,
    mediaType: 'movie' | 'tv',
): Promise<string | null> {
    try {
        const mediaInfo = await jellyseerrClient.getMediaByTmdbId(tmdbId, mediaType);
        return mediaInfo?.title || mediaInfo?.name || null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Request'],
            summary: 'List media requests',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Lists media requests. ' +
                "`?scope=mine` (default) returns the caller's own pending requests. " +
                '`?scope=all` returns all requests across all users and requires `requests:admin` scope. ' +
                '`?status=pending|approved|declined|all` filters by status (default: pending).\n\n' +
                '**Batch-fetch shortcuts** (short-circuit scope/status when present):\n' +
                '- `?ids=1,2,3` — fetch up to 50 specific requests by Jellyseerr ID (comma-separated). ' +
                'Non-admins only receive requests they own.\n' +
                '- `?externalId=tmdb:550` — fetch all requests whose media matches the given external ID ' +
                '(format: `provider:value`; currently only `tmdb` is supported). ' +
                'Returns requests in **every** status, so an empty list means "never requested" — ' +
                'add `?mediaType=movie|series` to disambiguate, since a TMDB ID can name both a ' +
                'movie and a series. ' +
                '`ids` and `externalId` are mutually exclusive.\n\n' +
                'Note: these list rows carry only the coarse `status` label. For live download ' +
                'progress (`download.percentage`, `statusMessage`) use `POST /requests/status`.',
            query: z.object({
                scope: z.enum(['mine', 'all']).optional().meta({
                    description: 'mine = own requests; all = admin view (requires requests:admin)',
                }),
                status: z
                    .enum(['pending', 'approved', 'declined', 'all'])
                    .optional()
                    .meta({ description: 'Filter by request status (default: pending)' }),
                ids: z.string().optional().meta({
                    description:
                        'Comma-separated Jellyseerr request IDs (1–50). Mutually exclusive with externalId.',
                }),
                externalId: z.string().optional().meta({
                    description:
                        'External ID in provider:value format (e.g. tmdb:550). Mutually exclusive with ids.',
                }),
                mediaType: z
                    .enum(['movie', 'series'])
                    .optional()
                    .meta({
                        description:
                            'Narrows an `externalId` lookup to one media type. Recommended — a TMDB ID ' +
                            'can name both a movie and a series. `tv` is a legacy alias for `series`. ' +
                            'Ignored unless `externalId` is present.',
                    }),
            }),
            responses: {
                200: {
                    schema: RequestsListResponseSchema,
                    description: 'Media requests list',
                },
                400: 'Invalid batch parameters (ids/externalId format error or mutual exclusion)',
                401: 'Authentication required',
                403: 'Insufficient scope for scope=all',
                503: 'Jellyseerr unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Request'],
            summary: 'Create a media request',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Creates a new media request via Jellyseerr. ' +
                'Requires `hasRequestPermission` (configured via `REQUEST_GROUPS`). ' +
                'Pre-checks quota before submitting — returns 422 `quota_exceeded` if exhausted. ' +
                'Rate-limited: 20 requests per 60 seconds per user. ' +
                'Returns 201 + `Location` header pointing to the created request.',
            body: CreateRequestBodySchemaFromDocs,
            responses: {
                201: {
                    schema: CreateRequestResponseSchema,
                    description: 'Request created',
                },
                400: 'Validation error or unresolvable media ID',
                401: 'Authentication required',
                403: 'No request permission',
                422: 'Request quota exhausted',
                429: 'Rate limit exceeded',
                502: 'Jellyseerr API error',
                503: 'Jellyseerr unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        GET: { kind: 'user' },
        POST: { kind: 'user' },
    },
    request: {
        body: CreateRequestBodySchema,
        query: GetRequestsQuerySchema,
        queryMethods: ['GET'],
    },
    handlers: {
        /**
         * GET /requests?scope=mine|all&status=&ids=&externalId=
         *
         * Lists media requests.
         *   scope=mine (default) — caller's own pending/processing requests.
         *   scope=all            — all requests; requires `requests:admin` scope.
         *
         * Optional `status` filter: `pending` | `approved` | `declined` | `all`.
         * Folds the old `request/pending` RPC endpoint (now the default scope=mine path).
         *
         * Batch-fetch filters (mutually exclusive with scope/status):
         *   ids=1,2,3            — return only the requests with those Jellyseerr IDs.
         *   externalId=tmdb:550  — return any request whose media matches this external ID.
         *
         * When `ids` or `externalId` is present the handler short-circuits into
         * a lightweight batch fetch (scope / status are ignored for that path).
         * When `ids` or `externalId` is present the handler uses a lightweight batch fetch.
         */
        GET: async (event, _ctx) => {
            const { locals, url } = event;
            const listDismissals = (
                await getDismissalsForUser(
                    getEffectiveUser(event.request, locals.user?.username || config.DEFAULT_USER),
                )
            ).map(({ id, dismissedAt }) => ({ key: id, dismissedAt }));

            // ── Batch-fetch branch: ?ids= or ?externalId= ──────────────────────
            const rawIds = url.searchParams.get('ids');
            const rawExternalId = url.searchParams.get('externalId');

            if (rawIds !== null || rawExternalId !== null) {
                // Both params together is not supported — surface a clear error.
                if (rawIds !== null && rawExternalId !== null) {
                    return ApiProblem.validationFailed(
                        'ids and externalId are mutually exclusive — use one at a time',
                    );
                }

                if (!jellyseerrClient.isConfigured()) {
                    return ApiProblem.dependencyUnavailable('Jellyseerr is not configured');
                }

                // --- ?ids=1,2,3 ---
                if (rawIds !== null) {
                    const idParts = rawIds
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean);
                    if (idParts.length === 0 || idParts.length > 50) {
                        return ApiProblem.validationFailed(
                            'ids must be a comma-separated list of 1–50 positive integers',
                        );
                    }
                    const parsedIds = idParts.map(Number);
                    if (parsedIds.some((n) => !Number.isInteger(n) || n <= 0)) {
                        return ApiProblem.validationFailed(
                            'ids must contain only positive integers',
                        );
                    }

                    // Ownership check: non-admins can only see their own requests.
                    // We fetch individually and filter post-hoc.
                    const hasAdminScope = hasRequestsAdmin(locals);

                    const effectiveUsername = getEffectiveUser(
                        event.request,
                        locals.user?.username || config.DEFAULT_USER,
                    );

                    const results = await Promise.all(
                        parsedIds.map((id) => jellyseerrClient.getRequestById(id)),
                    );

                    const items = results
                        .filter((req): req is NonNullable<typeof req> => req !== null)
                        .filter((req) => {
                            // Ownership filter for non-admins
                            if (hasAdminScope) return true;
                            const reqUser =
                                req.requestedBy.username?.toLowerCase() ||
                                req.requestedBy.displayName?.toLowerCase();
                            return reqUser === effectiveUsername.toLowerCase();
                        })
                        .map((req) => {
                            const mediaType = toRequestType(req.type);
                            if (!mediaType) return null;

                            const relevantStatus =
                                req.is4k && req.media.status4k !== undefined
                                    ? req.media.status4k
                                    : req.media.status;

                            const externalIds: ExternalIds = { tmdb: String(req.media.tmdbId) };
                            const title =
                                req.mediaInfo?.title || req.mediaInfo?.name || `Request #${req.id}`;

                            return {
                                id: req.id,
                                seasons: req.seasons?.map((s) => s.seasonNumber),
                                dismissalKey: buildRequestDismissalExtKey(externalIds, mediaType)!,
                                externalIds,
                                mediaType,
                                title,
                                posterPath: req.mediaInfo?.posterPath ?? null,
                                status: getSimpleStatusLabel(req.status, relevantStatus),
                                requestedAt: req.createdAt,
                                is4k: req.is4k,
                            };
                        })
                        .filter((item): item is NonNullable<typeof item> => item !== null);

                    return json({
                        dismissals: listDismissals,
                        ...paginate(items, {
                            limit: items.length,
                            offset: 0,
                            hasMore: false,
                        }),
                    });
                }

                // --- ?externalId=tmdb:550 ---
                // Parse "provider:value" format.
                const colonIdx = rawExternalId!.indexOf(':');
                if (colonIdx === -1) {
                    return ApiProblem.validationFailed(
                        'externalId must be in provider:value format (e.g. tmdb:550)',
                    );
                }
                const provider = rawExternalId!.slice(0, colonIdx).toLowerCase();
                const providerValue = rawExternalId!.slice(colonIdx + 1);
                if (!provider || !providerValue) {
                    return ApiProblem.validationFailed(
                        'externalId must be in provider:value format (e.g. tmdb:550)',
                    );
                }

                // Currently only tmdb is supported (Jellyseerr is TMDB-native)
                if (provider !== 'tmdb') {
                    return ApiProblem.validationFailed(
                        `Unsupported provider '${provider}'. Supported: tmdb`,
                    );
                }

                const tmdbId = Number(providerValue);
                if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
                    return ApiProblem.validationFailed(
                        'tmdb ID in externalId must be a positive integer',
                    );
                }

                // Optional media-type filter. TMDB IDs are NOT unique across media
                // types (tmdb 1429 is both a movie and a series), so without this a
                // lookup for one can return the other. Absent = no type filter, which
                // keeps existing callers working.
                const rawMediaType = url.searchParams.get('mediaType');
                if (
                    rawMediaType !== null &&
                    rawMediaType !== 'movie' &&
                    rawMediaType !== 'series'
                ) {
                    return ApiProblem.validationFailed('mediaType must be movie or series');
                }
                // Closed union (movie|series|tv) → public token. Inline is correct here
                // per docs/dev/media-type-vocabulary.md: the pass-through arm cannot
                // carry a token the destination has no member for.
                const wantedType: 'movie' | 'series' | null =
                    rawMediaType === null ? null : rawMediaType === 'movie' ? 'movie' : 'series';

                const hasAdminScope = hasRequestsAdmin(locals);

                const effectiveUsername = getEffectiveUser(
                    event.request,
                    locals.user?.username || config.DEFAULT_USER,
                );

                // Fetch all requests and filter by TMDB ID client-side.
                // Jellyseerr doesn't expose a direct externalId filter — we use
                // the same bulk-fetch path as scope=all/scope=mine.
                try {
                    let rawRequests: Awaited<ReturnType<typeof jellyseerrClient.getRequests>>;

                    if (hasAdminScope) {
                        rawRequests = await fetchAllRequests({ status: 'all' });
                    } else {
                        // MUST NOT use getPendingRequestsForUser() here: it drops every
                        // request whose media is already AVAILABLE (jellyseerr.ts), so a
                        // fulfilled request came back as an empty list — indistinguishable
                        // from "never requested" on a media detail screen. This branch
                        // answers "has this been requested?", so it needs all statuses.
                        const link = await jellyseerrClient.resolveUserLink(effectiveUsername);
                        if (link.state === 'unavailable') {
                            return ApiProblem.dependencyUnavailable('Jellyseerr is not reachable');
                        }
                        if (link.state === 'not_linked') {
                            return json({
                                dismissals: listDismissals,
                                ...paginate([], { limit: 0, offset: 0, hasMore: false }),
                                linked: false,
                            });
                        }
                        rawRequests = await fetchAllRequests({
                            status: 'all',
                            requestedBy: link.user.id,
                        });
                    }

                    const matched = rawRequests.filter((req) => {
                        if (req.media.tmdbId !== tmdbId) return false;
                        if (!wantedType) return true;
                        return toRequestType(req.type) === wantedType;
                    });

                    const items = matched
                        .map((req) => {
                            const mediaType = toRequestType(req.type);
                            if (!mediaType) return null;

                            const relevantStatus =
                                req.is4k && req.media.status4k !== undefined
                                    ? req.media.status4k
                                    : req.media.status;

                            const externalIds: ExternalIds = { tmdb: String(req.media.tmdbId) };
                            const title =
                                req.mediaInfo?.title || req.mediaInfo?.name || `Request #${req.id}`;

                            return {
                                id: req.id,
                                seasons: req.seasons?.map((s) => s.seasonNumber),
                                dismissalKey: buildRequestDismissalExtKey(externalIds, mediaType)!,
                                externalIds,
                                mediaType,
                                title,
                                posterPath: req.mediaInfo?.posterPath ?? null,
                                status: getSimpleStatusLabel(req.status, relevantStatus),
                                requestedAt: req.createdAt,
                                is4k: req.is4k,
                            };
                        })
                        .filter((item): item is NonNullable<typeof item> => item !== null);

                    return json({
                        dismissals: listDismissals,
                        ...paginate(items, {
                            limit: items.length,
                            offset: 0,
                            hasMore: false,
                        }),
                    });
                } catch {
                    return ApiProblem.internalError('Failed to fetch requests');
                }
            }

            // ── Standard list branch ────────────────────────────────────────────
            const scope = url.searchParams.get('scope') ?? 'mine';

            // Reject unknown scope values immediately
            if (scope !== 'mine' && scope !== 'all') {
                return ApiProblem.validationFailed('scope must be mine or all');
            }

            // scope=all requires requests:admin (inline check to avoid an extra
            // authenticate() round-trip for the common scope=mine path).
            if (scope === 'all') {
                const hasAdminScope = hasRequestsAdmin(locals);
                if (!hasAdminScope) {
                    return ApiProblem.scopeRequired(['requests:admin']);
                }
            }

            // `status` filter — forwarded to Jellyseerr; defaults to `pending`
            const rawStatus = url.searchParams.get('status') ?? 'pending';
            const statusFilter =
                rawStatus === 'approved' || rawStatus === 'declined' || rawStatus === 'all'
                    ? rawStatus
                    : 'pending';

            const effectiveUsername = getEffectiveUser(
                event.request,
                locals.user?.username || config.DEFAULT_USER,
            );

            // For scope=all skip per-user link check (admin may not have a Jellyseerr account);
            // just do a reachability probe via getRequests. For scope=mine we need the link
            // to know which Jellyseerr user to query.
            if (scope === 'all') {
                try {
                    const rawRequests = await jellyseerrClient.getRequests({
                        take: 100,
                        status: statusFilter,
                    });

                    // Filter out entries the UI cannot render usefully
                    const { kept: afterArrOrphans } = await filterOrphanedRequests(rawRequests);
                    const { kept: requests } =
                        await filterRequestsWithoutCatalogMatch(afterArrOrphans);

                    const items = await Promise.all(
                        requests.map(async (req: JellyseerrRequest) => {
                            let title = req.mediaInfo?.title || req.mediaInfo?.name;
                            if (!title) {
                                title =
                                    (await getTitleFromJellyseerr(req.media.tmdbId, req.type)) ||
                                    `Request #${req.id}`;
                            }

                            const relevantStatus =
                                req.is4k && req.media.status4k !== undefined
                                    ? req.media.status4k
                                    : req.media.status;

                            const externalIds: ExternalIds = { tmdb: String(req.media.tmdbId) };

                            // Canonicalise mediaType: `tv` → `series`
                            const mediaType = toRequestType(req.type);
                            if (!mediaType) return null;

                            return {
                                id: req.id,
                                seasons: req.seasons?.map((s) => s.seasonNumber),
                                dismissalKey: buildRequestDismissalExtKey(externalIds, mediaType)!,
                                externalIds,
                                mediaType,
                                title,
                                posterPath: req.mediaInfo?.posterPath || null,
                                status: getSimpleStatusLabel(req.status, relevantStatus),
                                requestedAt: req.createdAt,
                                is4k: req.is4k,
                            };
                        }),
                    );

                    const validItems = items.filter((item) => item !== null);
                    return json({
                        dismissals: listDismissals,
                        ...paginate(validItems, {
                            limit: validItems.length,
                            offset: 0,
                            hasMore: false,
                        }),
                    });
                } catch {
                    return ApiProblem.internalError('Failed to fetch requests');
                }
            }

            // scope=mine path — needs per-user Jellyseerr link
            const link = await jellyseerrClient.resolveUserLink(effectiveUsername);
            if (link.state === 'unavailable') {
                // Dependency down → 503, never 200 with empty array
                return ApiProblem.dependencyUnavailable('Jellyseerr is not reachable');
            }
            if (link.state === 'not_linked') {
                // Benign state: user has no Jellyseerr account
                return json({
                    dismissals: listDismissals,
                    ...paginate([], { limit: 20, offset: 0, hasMore: false }),
                    linked: false,
                });
            }

            try {
                const rawPendingRequests =
                    await jellyseerrClient.getPendingRequestsForUser(effectiveUsername);

                // Filter out entries the UI cannot render usefully
                const { kept: afterArrOrphans } = await filterOrphanedRequests(rawPendingRequests);
                const { kept: pendingRequests } =
                    await filterRequestsWithoutCatalogMatch(afterArrOrphans);

                // Apply status filter when not default (pending path fetches pending only)
                const filteredRequests =
                    statusFilter === 'pending'
                        ? pendingRequests
                        : statusFilter === 'all'
                          ? pendingRequests
                          : pendingRequests.filter((req) => {
                                if (statusFilter === 'approved') return req.status === 2;
                                if (statusFilter === 'declined') return req.status === 3;
                                return true;
                            });

                const items = await Promise.all(
                    filteredRequests.map(async (req: JellyseerrRequest) => {
                        let title = req.mediaInfo?.title || req.mediaInfo?.name;
                        if (!title) {
                            title =
                                (await getTitleFromJellyseerr(req.media.tmdbId, req.type)) ||
                                `Request #${req.id}`;
                        }

                        const relevantStatus =
                            req.is4k && req.media.status4k !== undefined
                                ? req.media.status4k
                                : req.media.status;

                        const externalIds: ExternalIds = { tmdb: String(req.media.tmdbId) };

                        const mediaType = toRequestType(req.type);
                        if (!mediaType) return null;

                        return {
                            id: req.id,
                            seasons: req.seasons?.map((s) => s.seasonNumber),
                            dismissalKey: buildRequestDismissalExtKey(externalIds, mediaType)!,
                            externalIds,
                            mediaType,
                            title,
                            posterPath: req.mediaInfo?.posterPath || null,
                            status: getSimpleStatusLabel(req.status, relevantStatus),
                            requestedAt: req.createdAt,
                            is4k: req.is4k,
                        };
                    }),
                );

                const validItems = items.filter((item) => item !== null);

                return json({
                    dismissals: listDismissals,
                    ...paginate(validItems, {
                        limit: validItems.length,
                        offset: 0,
                        hasMore: false,
                    }),
                    linked: true,
                });
            } catch {
                return ApiProblem.internalError('Failed to fetch requests');
            }
        },

        /**
         * POST /requests
         *
         * Create a new media request via Jellyseerr.
         *
         * Enforces `hasRequestPermission` server-side — P0 bug fix (was UI-gated only).
         * Pre-checks quota before submitting; returns 422 quota_exceeded if exhausted.
         * Rate-limited: 20 requests per 60 seconds per user.
         * Returns 201 + Location header.
         */
        POST: async (event, ctx) => {
            // Permission is gated BEFORE the body is parsed, as it always was:
            // a caller who may not request must not be able to tell a malformed
            // body (422) from a denial (403). `requestManager.createRequest`
            // re-checks it — this is the ordering, not the authority.
            if (!event.locals.user?.hasRequestPermission) {
                return requestPermissionProblem();
            }

            // When called via mount(), the body was already validated by validateRequest
            // and is available on ctx.input.body (body stream consumed).  When the handler
            // is called directly (unit tests, legacy wiring without mount()), fall back to
            // re-parsing the body from the request stream.
            let parsedBody: {
                externalIds: Record<string, string>;
                mediaType: 'movie' | 'tv';
                seasons?: number[];
            };
            if (ctx.input?.body) {
                parsedBody = ctx.input.body;
            } else {
                let rawBody: unknown;
                try {
                    rawBody = await event.request.json();
                } catch {
                    return ApiProblem.validationFailed('Request body must be valid JSON');
                }
                const result = CreateRequestBodySchema.safeParse(rawBody);
                if (!result.success) {
                    return ApiProblem.validationFailed(
                        result.error.issues.map((e) => ({
                            field: e.path.join('.'),
                            message: e.message,
                        })),
                    );
                }
                parsedBody = result.data;
            }
            const { externalIds, mediaType, seasons } = parsedBody;

            const effectiveUsername = getEffectiveUser(
                event.request,
                event.locals.user?.username || config.DEFAULT_USER,
            );

            const outcome = await requestManager.createRequest({
                user: event.locals.user,
                effectiveUsername,
                // The rate limit has always been keyed per client IP + username.
                rateLimitScope: getClientIp(event),
                externalIds: externalIds as ExternalIds,
                mediaType,
                seasons,
            });

            const problem = createOutcomeToProblem(outcome);
            if (problem) return problem;
            // Narrowed by createOutcomeToProblem returning null only for 'created'.
            if (outcome.kind !== 'created') {
                return ApiProblem.badGateway('Failed to create request');
            }

            const { requestId, requestedAt } = outcome;

            return new Response(JSON.stringify({ id: requestId, requestedAt }), {
                status: 201,
                headers: {
                    'Content-Type': 'application/json',
                    Location: apiUrl(ctx.surface, `/requests/${requestId}`),
                },
            });
        },
    },
});
