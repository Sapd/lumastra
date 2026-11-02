// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holiday Recommendations API
 *
 * Returns personalized holiday-themed content recommendations.
 * Uses the configurable holiday plugin system.
 *
 * Configuration:
 * - Edit static/config/holidays.json to customize holidays, sources, and content
 * - Set HOLIDAY_CONFIG_PATH env var for custom config location
 * - In development: Changes are hot-reloaded (polling every 10s)
 * - In production: Restart server or call reloadConfig() to apply changes
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { refreshRateLimit } from '$lib/server/api/defs/recommendations/_refresh-rate-limit.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { config, features } from '$lib/server/config.js';
import { holidayPlugin } from '$lib/server/plugins/holidays';
import { Logger } from '$lib/server/utils/logger';
import * as m from '$lib/paraglide/messages';
import { getHolidaySettings } from '$lib/server/plugins/holidays/config-loader.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    buildSearchAccessContext,
    type SearchAccessContext,
} from '$lib/server/utils/search-access-context.js';

const logger = Logger.for('HolidayRecommendations');

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const HolidayQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ---------------------------------------------------------------------------
// Response schema (typed — no z.any() / passthrough)
// ---------------------------------------------------------------------------

const HolidayItemSchema = z.object({
    id: z.string().optional(),
    /**
     * Canonical media-type discriminator ('movie' | 'tv').
     * The plugin emits 'mediaType'; this field is the pass-through alias so
     * both the old 'type' key and the plugin's 'mediaType' key survive Zod
     * stripping. The SPA consumer reads `rec.mediaType`.
     */
    mediaType: z.enum(['movie', 'tv']).optional(),
    title: z.string().optional(),
    /**
     * Self-describing image href map (role → { href }).
     * Preferred over flat posterPath/backdropPath.
     */
    images: z.record(z.string(), z.object({ href: z.string() })).optional(),
    /**
     * Provider-agnostic external IDs (e.g. { tmdb: '550', jellyfin: '...' }).
     * The plugin already emits this key; declaring it here keeps it in the
     * wire payload instead of being stripped by Zod.
     */
    // Values are optional: an unmatched provider id may arrive as `undefined`
    // (dropped by JSON.stringify) and must not turn the whole response into a 500.
    externalIds: z.record(z.string(), z.string().optional()).optional(),
    isAvailable: z.boolean().optional(),
    canRequest: z.boolean().optional(),
    trailerUrl: z.string().optional(),
    overview: z.string().optional(),
    rating: z.number().optional(),
    genres: z.array(z.number()).optional(),
    criticRating: z.number().optional(),
    aiSuggestion: z.boolean().optional(),
    holidayThemed: z.boolean().optional(),
    holidayId: z.string().optional(),
    holidayName: z.string().optional(),
    availabilitySource: z.string().optional(),
    userRating: z.number().optional(),
});

// Display fields only. This used to `.catchall()` the whole HolidayConfig onto
// the wire — sources, keyword/collection ids, MDBList list paths and
// validation terms went to every user.
const HolidayHolidaySchema = z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    localizedNames: z.record(z.string(), z.string()).optional(),
    emoji: z.string().optional(),
    backgroundColor: z.string().optional(),
    textColor: z.string().optional(),
    backgroundImage: z.string().optional(),
    startMonth: z.number().optional(),
    startDay: z.number().optional(),
    endMonth: z.number().optional(),
    endDay: z.number().optional(),
});

type HolidayItem = z.infer<typeof HolidayItemSchema>;

/**
 * Validate items one by one: a single malformed item is dropped and logged
 * instead of turning the whole Home shelf into a 500 for the cache TTL (what
 * happened twice in the week of 2026-10-02).
 */
function validItems(items: unknown[]): HolidayItem[] {
    const out: HolidayItem[] = [];
    for (const [index, item] of items.entries()) {
        const parsed = HolidayItemSchema.safeParse(item);
        if (parsed.success) {
            out.push(parsed.data);
        } else {
            logger.warn('Dropping malformed holiday item', {
                index,
                issues: parsed.error.issues.slice(0, 3),
            });
        }
    }
    return out;
}

const HolidayResponseSchema = z.object({
    active: z.boolean(),
    holiday: HolidayHolidaySchema.optional(),
    items: z.array(HolidayItemSchema),
    cached: z.boolean().optional(),
    message: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        query: HolidayQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            if (event.request.method === 'GET' && event.url.searchParams.has('refresh'))
                return ApiProblem.validationFailed('Use the POST refresh action');
            const { locals, request } = event;

            // Off by default (DISABLE_HOLIDAY_RECOMMENDATIONS). Checked first so a
            // client that still asks gets a quiet empty 200, never a 403/500.
            if (!features.holidays) {
                // no-store: turning the setting on must take effect at once.
                return json(
                    HolidayResponseSchema.parse({
                        active: false,
                        message: 'Holiday recommendations are disabled',
                        items: [],
                    }),
                    { headers: { 'Cache-Control': 'no-store' } },
                );
            }

            // Age-restricted users cannot access holiday recommendations
            if (locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'Holiday recommendations are not available for age-restricted profiles',
                );
            }

            // Get plugin settings and check if enabled
            const settings = getHolidaySettings();
            if (!settings.enabled) {
                return json(
                    HolidayResponseSchema.parse({
                        active: false,
                        message: 'Holiday recommendations are disabled',
                        items: [],
                    }),
                );
            }

            const query = ctx.input!.query;
            const refresh = event.request.method === 'POST';

            // Validate and cap limit parameter
            const MAX_LIMIT = 100;
            const MIN_LIMIT = 1;
            let limit = settings.defaultLimit;
            if (query.limit !== undefined) {
                limit = Math.max(MIN_LIMIT, Math.min(query.limit, MAX_LIMIT));
            }

            // Development user override
            const effectiveUsername = getEffectiveUser(
                request,
                locals.user?.username || config.DEFAULT_USER,
            );

            try {
                // The caller's library/age boundary scopes discovery and
                // availability. Without a DB the plugin falls back to
                // TMDB-only results with nothing marked available.
                const sql = getDb();
                const access: SearchAccessContext | null =
                    sql && locals.user ? await buildSearchAccessContext(sql, locals.user) : null;

                const result = await holidayPlugin.getRecommendations(effectiveUsername, {
                    limit,
                    refresh,
                    access,
                });

                if (!result.active) {
                    return json(
                        HolidayResponseSchema.parse({
                            active: false,
                            message: result.message || m.holiday_no_active_season(),
                            items: [],
                        }),
                    );
                }

                return json(
                    HolidayResponseSchema.parse({
                        active: result.active,
                        holiday: result.holiday ?? undefined,
                        items: validItems(result.items ?? []),
                        cached: result.cached,
                    }),
                );
            } catch (error) {
                logger.error('Error generating holiday recommendations', error as Error);
                return ApiProblem.internalError('Failed to generate holiday recommendations');
            }
        },
    },
});

export const refreshDef = defineEndpoint({
    auth: def.auth,
    rateLimit: refreshRateLimit,
    visibility: 'internal',
    request: {
        body: HolidayQuerySchema.loose().superRefine((body, ctx) => {
            for (const field of ['refresh', 'offset', 'cursor']) {
                if (field in body)
                    ctx.addIssue({
                        code: 'custom',
                        path: [field],
                        message: 'Not accepted by this refresh action',
                    });
            }
        }),
    },
    handlers: {
        POST: (event, ctx) =>
            def.handlers.GET!(event, {
                ...ctx,
                input: { query: ctx.input!.body, body: undefined, params: undefined },
            }),
    },
});
