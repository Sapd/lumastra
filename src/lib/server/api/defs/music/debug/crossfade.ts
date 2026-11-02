// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/debug/crossfade.ts
 *
 * GET /api/music/debug/crossfade?from=<trackId>&to=<trackId>[&mood=chill]
 *
 * Admin-only debug endpoint: shows how two tracks would crossfade.
 * Returns a bare object (single resource) per contract.
 * Visibility: internal (never published to public OpenAPI spec).
 *
 * Errors: problem+json incl. 503 dependency_unavailable on DB-down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { extractAudioFeatures } from '$lib/server/services/music/track-projection';
import { getTrackDetail } from '$lib/server/database/queries/music.queries.js';
import {
    determineCrossfadeStyle,
    areKeysCompatible,
    calculateCrossfadeDuration,
    bpmGap as computeBpmGap,
} from '$lib/utils/beat-math.js';

const querySchema = z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    mood: z.string().optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: {
        query: querySchema,
    },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const fromId = event.url.searchParams.get('from');
            const toId = event.url.searchParams.get('to');
            if (!fromId || !toId) {
                return ApiProblem.validationFailed([
                    {
                        field: 'from,to',
                        message: 'Both "from" and "to" track ID query parameters are required',
                    },
                ]);
            }

            const channelMood = event.url.searchParams.get('mood') ?? undefined;

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const [fromTrack, toTrack] = await Promise.all([
                getTrackDetail(sql, fromId),
                getTrackDetail(sql, toId),
            ]);

            if (!fromTrack) return ApiProblem.notFound('From track not found');
            if (!toTrack) return ApiProblem.notFound('To track not found');

            const outgoing = extractAudioFeatures(fromTrack.custom_metadata);
            const incoming = extractAudioFeatures(toTrack.custom_metadata);
            const style = determineCrossfadeStyle(outgoing, incoming, channelMood);

            const outBpm = outgoing?.bpm ?? 0;
            const inBpm = incoming?.bpm ?? 0;
            const rawGap = computeBpmGap(outBpm, inBpm);
            const bpmGap = rawGap === null ? null : Math.round(rawGap * 100);
            const keysCompatible =
                outgoing?.key && incoming?.key
                    ? areKeysCompatible(outgoing.key, incoming.key)
                    : null;
            const fadeDurationMs = calculateCrossfadeDuration(outBpm || inBpm || 120, style.beats);

            // Bare object — single resource per contract.
            return json({
                from: {
                    id: fromTrack.id,
                    title: fromTrack.title,
                    audioFeatures: outgoing ?? null,
                },
                to: {
                    id: toTrack.id,
                    title: toTrack.title,
                    audioFeatures: incoming ?? null,
                },
                crossfade: {
                    fadeMode: style.fadeMode,
                    beats: style.beats,
                    reason: style.reason,
                    fadeDurationMs,
                    fadeDurationSec: +(fadeDurationMs / 1000).toFixed(1),
                },
                analysis: {
                    bpmGapPercent: bpmGap,
                    keysCompatible,
                    channelMood: channelMood ?? null,
                },
            });
        },
    },
});
