// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Feature Flag Middleware
 *
 * Provides middleware factories for checking feature flags from app config.
 * Returns 404 (not 403) when features are disabled to match existing inline behavior.
 *
 * @example
 * // Protect a playlist route
 * export const GET = requireFeature('playlists')(
 *     requireAuth(
 *         withErrorHandler(async ({ locals }) => {
 *             // Handler implementation
 *             return json({ data });
 *         })
 *     )
 * );
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { ApiResponses, getEndpointName } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('FeatureFlagMiddleware');

/**
 * Feature flag keys that can be checked
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
export type FeatureFlag = keyof typeof import('$lib/server/config').features;

/**
 * Require a specific feature to be enabled
 *
 * Returns 404 if the feature is disabled (matching existing inline behavior).
 * This middleware should be applied before withErrorHandler.
 *
 * @param flag - The feature flag key to check (e.g., 'playlists', 'chat', 'aiRecommendations')
 * @returns Middleware factory that checks the feature flag
 *
 * @example
 * export const GET = requireFeature('playlists')(
 *     requireAuth(withErrorHandler(handler))
 * );
 */
export function requireFeature(flag: FeatureFlag) {
    return function (handler: RequestHandler): RequestHandler {
        return async (event: RequestEvent): Promise<Response> => {
            const endpoint = getEndpointName(event);

            try {
                // Dynamic import to avoid circular dependencies
                const { features } = await import('$lib/server/config');

                // Check if feature is enabled
                const isEnabled = features[flag];

                if (!isEnabled) {
                    logger.debug('Feature disabled', {
                        endpoint,
                        feature: flag,
                        user: event.locals.user?.username,
                    });

                    // Return 404 to match existing inline behavior
                    // (features that are disabled appear as "not found")
                    return ApiResponses.notFound('Feature not available', endpoint);
                }

                // Feature is enabled, proceed to handler
                return await handler(event);
            } catch (error) {
                logger.error('Error checking feature flag', error as Error, {
                    endpoint,
                    feature: flag,
                });
                return ApiResponses.error(
                    'Feature check failed',
                    error instanceof Error ? error : new Error('Unknown error'),
                    500,
                    endpoint,
                );
            }
        };
    };
}
