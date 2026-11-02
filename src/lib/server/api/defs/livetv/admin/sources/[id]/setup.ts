// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/sources/[id]/setup.ts
 *
 * GET  /livetv/admin/sources/{sourceId}/setup — fetch guided-setup summary
 * POST /livetv/admin/sources/{sourceId}/setup — apply guided-setup preferences
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response bodies:
 *   GET  → { totalChannels, visibleChannels, categories, qualityDistribution,
 *             detectedRegions, regionalVariantCount, regions, untaggedChannelCount,
 *             loopChannelCount, infoChannelCount, eventSlotCount,
 *             localStationCount, radioChannelCount, savedSetup? }   (bare object)
 *   POST → SetupResult (bare object — passed through from applySetupPreferences)
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getSetupSummary } from '$lib/server/database/queries/livetv-setup.queries.js';
import { applySetupPreferences } from '$lib/server/services/livetv/index.js';
import {
    NOISE_SWITCH_KEYS,
    getLineupNoiseCounts,
} from '$lib/server/services/livetv/livetv-setup.service.js';
import { parseLineupFilter } from '$lib/server/services/livetv/lineup-filter.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { SetupPreferencesSchema } from '$lib/schemas/livetv.js';
import { SetupSummarySchema, SetupResultSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'Get the guided-setup summary for a source',
            stability: 'experimental',
            auth: 'bearer',
            responses: {
                200: { schema: SetupSummarySchema, description: 'Guided-setup summary' },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Live TV'],
            summary: 'Apply guided-setup preferences to a source',
            stability: 'experimental',
            auth: 'bearer',
            body: SetupPreferencesSchema,
            responses: {
                200: { schema: SetupResultSchema, description: 'Setup applied' },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        params: z.object({ sourceId: z.string().min(1) }),
        body: SetupPreferencesSchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { sourceId } = ctx.input!.params;
            const [{ summary, categories, detectedRegions, regions, lineupFilter }, noise] =
                await Promise.all([
                    getSetupSummary(sql, sourceId),
                    getLineupNoiseCounts(sql, sourceId),
                ]);
            const savedFilter = parseLineupFilter(lineupFilter);
            const stored = (lineupFilter ?? {}) as Record<string, unknown>;
            // A filter stored before a switch existed did not choose it: leave
            // it out, so the setup offers that switch's default.
            const savedSwitches = Object.fromEntries(
                NOISE_SWITCH_KEYS.flatMap((key) =>
                    typeof stored[key] === 'boolean' ? [[key, stored[key]]] : [],
                ),
            );

            return json({
                totalChannels: Number(summary.total_channels),
                visibleChannels: Number(summary.visible_channels),
                categories: categories.map((c) => ({
                    name: c.name,
                    channelCount: Number(c.channel_count),
                })),
                qualityDistribution: {
                    uhd: Number(summary.quality_uhd),
                    fhd: Number(summary.quality_fhd),
                    hd: Number(summary.quality_hd),
                    sd: Number(summary.quality_sd),
                    unknown: Number(summary.quality_unknown),
                },
                detectedRegions,
                regionalVariantCount: Number(summary.regional_variant_count),
                regions: regions.map((r) => ({
                    code: r.code,
                    channelCount: Number(r.channel_count),
                })),
                untaggedChannelCount: Number(summary.untagged_channels),
                loopChannelCount: noise.loop,
                infoChannelCount: noise.info,
                eventSlotCount: noise.eventSlot,
                localStationCount: noise.localStation,
                radioChannelCount: noise.radio,
                ...(savedFilter && {
                    savedSetup: {
                        countries: savedFilter.countries,
                        includeUntagged: savedFilter.includeUntagged,
                        hideLoopChannels: savedFilter.hideLoopChannels,
                        hiddenCategories: savedFilter.hiddenCategories,
                        ...savedSwitches,
                        ...(stored.channelOrder === 'traditional' ||
                        stored.channelOrder === 'sports-first'
                            ? { channelOrder: stored.channelOrder }
                            : {}),
                        ...(typeof stored.preferHighQuality === 'boolean'
                            ? { preferHighQuality: stored.preferHighQuality }
                            : {}),
                    },
                }),
            });
        },

        POST: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { sourceId } = ctx.input!.params;
            const result = await applySetupPreferences(sql, {
                sourceId,
                ...ctx.input!.body,
            });

            await invalidateLiveTvCaches();

            return json(result as unknown as Record<string, unknown>);
        },
    },
});
