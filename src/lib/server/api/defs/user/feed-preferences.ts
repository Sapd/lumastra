// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/feed-preferences.ts — GET /user/feed-preferences
 *                                  PUT /user/feed-preferences
 *
 * Per-user For You feed preferences.
 *
 * GET → bare object { feedMode, hiddenSectionKinds } (defaults when never set).
 * PUT → partial update: either field may be omitted; the other is preserved.
 *       `hiddenSectionKinds` is sanitised server-side (unknown kinds dropped,
 *       essentials stripped) so a crafted request can never blank the home feed.
 *
 * Auth: {kind:'user'} — self-scoped.
 * Errors: problem+json, incl. 503 dependency_unavailable on DB-down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getFeedPreferences,
    upsertFeedPreferencesFull,
} from '$lib/server/database/queries/index.js';
import { sanitizeHiddenKinds, type FeedMode } from '$lib/shared/feed-section-kinds.js';
import { feedPreferencesSchema } from '$lib/schemas/user.js';

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: {
        body: feedPreferencesSchema,
    },
    handlers: {
        /**
         * GET /user/feed-preferences
         *
         * Returns the user's current feed preferences. Defaults to
         * { feedMode: 'full', hiddenSectionKinds: [] } when not yet set.
         */
        GET: async (event, _ctx) => {
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            const row = await getFeedPreferences.one(sql, { userId });

            return json(
                {
                    feedMode: row?.feed_mode ?? 'full',
                    hiddenSectionKinds: row?.hidden_section_kinds ?? [],
                },
                { headers: { 'Cache-Control': 'private, max-age=300' } },
            );
        },

        /**
         * PUT /user/feed-preferences
         *
         * Partial update: either field may be omitted; the other is preserved
         * from the current DB row. Validates and sanitises hiddenSectionKinds.
         */
        PUT: async (event, ctx) => {
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            const body = ctx.input?.body as
                { feedMode?: FeedMode; hiddenSectionKinds?: string[] } | undefined;
            const { feedMode, hiddenSectionKinds } = body ?? {};

            // Partial update: preserve whichever field the caller did not send
            const current = await getFeedPreferences.one(sql, { userId });
            const nextMode: FeedMode = feedMode ?? current?.feed_mode ?? 'full';
            const nextHidden = sanitizeHiddenKinds(
                hiddenSectionKinds ?? current?.hidden_section_kinds ?? [],
            );

            const row = await upsertFeedPreferencesFull.one(sql, {
                userId,
                feedMode: nextMode,
                hiddenSectionKinds: nextHidden,
            });

            return json(
                {
                    feedMode: row?.feed_mode ?? nextMode,
                    hiddenSectionKinds: row?.hidden_section_kinds ?? nextHidden,
                },
                { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } },
            );
        },
    },
});
