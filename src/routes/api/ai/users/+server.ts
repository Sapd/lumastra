// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/ai/users
 *
 * Admin endpoint: list all users with their AI data, privacy settings, and groups.
 *
 * Response: { items, page } collection via paginate() + problem+json errors
 * incl. 503 dependency_unavailable when the AI DB is down.
 *
 * Auth: admin. Surface: internal.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service';
import { AiUserItemSchema } from '$lib/schemas/api-ai-responses.js';

// Internal DB row type (snake_case)
interface UserRow {
    user_id: string;
    has_profile: boolean;
    total_ratings: number | string;
    current_ratings: number | string;
    active_suggestions: number | string;
    last_activity: Date | null;
    hide_streams: boolean;
    groups: string[] | null;
    groups_updated_at: Date | null;
}

function toNumber(value: number | string): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function toUserResponse(row: UserRow) {
    return {
        userId: row.user_id,
        hasProfile: row.has_profile,
        totalRatings: toNumber(row.total_ratings),
        currentRatings: toNumber(row.current_ratings),
        activeSuggestions: toNumber(row.active_suggestions),
        lastActivity: row.last_activity ? row.last_activity.toISOString() : null,
        hideStreams: row.hide_streams,
        groups: row.groups,
        groupsUpdatedAt: row.groups_updated_at ? row.groups_updated_at.toISOString() : null,
    };
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('AI database is not available');
            }

            const users = await sql<UserRow[]>`
        WITH user_stats AS (
          SELECT
            up.user_id,
            (up.catalog_embedding IS NOT NULL OR up.request_embedding IS NOT NULL) as has_profile,
            up.total_ratings,
            up.last_activity,
            COUNT(ur.id) as current_ratings,
            COUNT(us.id) as active_suggestions
          FROM user_profiles up
          LEFT JOIN user_ratings ur ON up.user_id = ur.user_id AND ur.created_at > NOW() - INTERVAL '30 days'
          LEFT JOIN user_suggestions us ON up.user_id = us.user_id AND us.expires_at > NOW()
          GROUP BY up.user_id, up.catalog_embedding, up.request_embedding, up.total_ratings, up.last_activity
        )
        SELECT
          us.user_id,
          us.has_profile,
          us.total_ratings,
          us.current_ratings,
          us.active_suggestions,
          us.last_activity,
          COALESCE(u.hide_streams, false) as hide_streams,
          u.groups,
          u.groups_updated_at
        FROM user_stats us
        LEFT JOIN users u ON u.id = us.user_id
        ORDER BY us.last_activity DESC NULLS LAST
      `;

            const items = AiUserItemSchema.array().parse(users.map(toUserResponse));
            return json(
                paginate(items, {
                    limit: items.length,
                    offset: 0,
                    hasMore: false,
                    total: items.length,
                }),
            );
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
