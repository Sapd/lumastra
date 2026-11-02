// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/parties.ts
 *
 * Listed visibility is the host’s explicit choice and is not blocked by the hide-my-streams privacy switch.
 *
 *   GET /watch-together/parties → paginate({ items: PublicParty[], page })
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 * Access-gate: per-item age+library filtering applied to sessions list.
 */

import { toPublicParties } from '$lib/server/services/watch-together-public';
import { publicAuthorSchema } from '$lib/schemas/public-author';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getAllSessions } from '$lib/server/services/watch-together.service.js';
import { isWidgetDisabled } from '$lib/server/utils/widget-guard.js';
import { getDb } from '$lib/server/database/index.js';
import {
    filterSessionsByAccess,
    resolveWatchTogetherBoundary,
} from '$lib/server/utils/watch-together-access.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import { nonEmptyStringSchema } from '$lib/schemas/common.js';

const logger = Logger.for('WatchTogether');

// ---------------------------------------------------------------------------
// Public session item schema — what the sessions listing exposes to clients
// ---------------------------------------------------------------------------

/**
 * Fully-typed public session shape (no z.unknown / z.any).
 * Represents a watch-together session as visible to other users.
 */
export const PublicWatchTogetherPartySchema = z
    .object({
        code: nonEmptyStringSchema.describe('Session code'),
        host: publicAuthorSchema,
        title: nonEmptyStringSchema.describe('Media title being watched'),
        mediaType: z
            .enum(['movie', 'episode', 'series'])
            .describe('Canonical media type (series replaces tv/show)'),
        isPlaying: z.boolean().describe('Whether playback is currently active'),
        participantCount: z.number().min(0).describe('Number of participants (connected devices)'),
        createdAt: z.number().describe('Unix timestamp (ms) when session was created'),
        visibility: z
            .enum(['unlisted', 'listed'])
            .describe('Whether the session is publicly listed'),
    })
    .meta({ id: 'WT_PublicParty' });

export type PublicWatchTogetherParty = z.infer<typeof PublicWatchTogetherPartySchema>;

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    handlers: {
        /**
         * GET /watch-together/parties
         *
         * Returns all active public watch-together sessions, filtered by the
         * authenticated user's library/age access context.
         *
         * Response: paginate({ items: PublicWatchTogetherParty[], page })
         * with a synthetic page block (no offset pagination — sessions are in-memory).
         */
        GET: async (event, ctx) => {
            if (isWidgetDisabled('watch-parties')) {
                return json(paginate([], { limit: 0, offset: 0, hasMore: false, total: 0 }));
            }

            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            try {
                const sessions = await getAllSessions();

                // The boundary is REQUIRED and resolved fail-CLOSED: a missing
                // database handle or a throw inside buildSearchAccessContext
                // yields denyAllAccess(), never "no filtering". Shared with the
                // v1-native duplicate at
                // routes/api/v1/watch-together/parties/+server.ts — the parity
                // tests allowlist that route, so the two copies must not drift.
                const sql = getDb();
                const boundary = await resolveWatchTogetherBoundary(sql, event.locals.user);
                const visibleSessions = await filterSessionsByAccess(sql, sessions, boundary);

                // Map internal session to the public shape, canonicalising mediaType
                const parties = await toPublicParties(visibleSessions, ctx.surface);
                const items: PublicWatchTogetherParty[] = parties.map((s) => ({
                    code: s.code,
                    host: s.host,
                    title: s.title,
                    mediaType: (toPublicMediaType(s.mediaType) ??
                        s.mediaType) as PublicWatchTogetherParty['mediaType'],
                    isPlaying: s.isPlaying,
                    participantCount: s.participants.length,
                    createdAt: s.createdAt,
                    visibility: s.visibility,
                }));

                return json(
                    paginate(items, {
                        limit: items.length,
                        offset: 0,
                        hasMore: false,
                        total: items.length,
                    }),
                );
            } catch (err) {
                logger.error('List sessions error', err as Error);
                return ApiProblem.internalError('Failed to list sessions');
            }
        },
    },
});
