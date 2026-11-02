// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reset AI Profile Endpoint
 *
 * Deletes all AI-related data for a user:
 * - User ratings
 * - User suggestions
 * - User profile
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    deleteUserRatingsSimple,
    deleteUserSuggestions,
    deleteUserProfile,
} from '$lib/server/database/queries';

const logger = Logger.for('ResetProfileAPI');

const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        POST: async (event, _ctx) => {
            // Use dev user override system
            const { getEffectiveUser } = await import('$lib/server/dev-user');
            const authenticatedUser = event.locals.user?.username;
            const userId = getEffectiveUser(event.request, authenticatedUser);
            logger.info('Resolved user for profile reset', { userId });

            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries');
            const resolvedUserId = await getUserIdByUsername(sql, userId);
            if (!resolvedUserId) {
                return ApiProblem.notFound('User not found');
            }

            // Delete all AI data using centralized queries
            await Promise.all([
                deleteUserRatingsSimple(sql, resolvedUserId),
                deleteUserSuggestions(sql, resolvedUserId),
                deleteUserProfile(sql, resolvedUserId),
            ]);

            logger.info('Successfully reset AI profile', { userId });

            return json({
                message: 'AI profile reset successfully',
                user_id: userId,
            });
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
