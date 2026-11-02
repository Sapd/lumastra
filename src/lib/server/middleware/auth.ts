// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    AuthDependencyUnavailableError,
    authUnavailableResponse,
} from '$lib/server/auth/dependency-unavailable.js';

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { ApiResponses, getEndpointName } from '$lib/server/utils/api-responses';
import { getClientIp } from '$lib/server/utils/client-ip';
import { Logger } from '$lib/server/utils/logger';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import { isDelegatedAdmin } from '$lib/server/api/delegate.js';

const logger = Logger.for('AuthMiddleware');

/**
 * Authentication Middleware for API Endpoints
 *
 * Eliminates duplicate permission checking patterns found in 20+ endpoints
 * Provides consistent authorization logic across all AI endpoints
 *
 * ## Middleware Composition Order
 *
 * Apply middleware from outermost to innermost in this order:
 * 1. `requireAuth` / `requireAdmin` - Authentication & authorization
 * 2. `requireFeature` - Feature flag checks (from feature-flag.ts)
 * 3. `withIdResolution` - Media ID resolution (from id-resolution.ts)
 * 4. `withErrorHandler` - Error handling wrapper (from error-handler.ts)
 * 5. `withValidation` - Request validation (from validate.ts)
 * 6. Handler - The actual route handler
 *
 * Note: `withAIErrorHandler` IS `createErrorHandler({...})` and replaces (not wraps) `withErrorHandler`.
 *
 * @example
 * // Simple admin route
 * export const GET = requireAdmin(
 *     withErrorHandler(async ({ locals }) => {
 *         return json({ data });
 *     })
 * );
 *
 * @example
 * // Admin route with body validation
 * export const POST = requireAdmin(
 *     withErrorHandler(
 *         withValidation({ body: MyBodySchema }, async ({ validated }) => {
 *             return json({ data: validated.body });
 *         })
 *     )
 * );
 *
 * @example
 * // Feature-gated user route
 * export const GET = requireFeature('playlists')(
 *     requireAuth(
 *         withErrorHandler(async ({ locals }) => {
 *             return json({ data });
 *         })
 *     )
 * );
 *
 * @example
 * // Feature-gated route with ID resolution
 * export const GET = requireFeature('ai')(
 *     requireAuth(
 *         withErrorHandler(
 *             withIdResolution(async ({ locals, resolved }) => {
 *                 return json({ id: resolved.uuid });
 *             })
 *         )
 *     )
 * );
 */

/**
 * Require admin privileges for endpoint access
 *
 * Accepts both session/forward-auth identities (via `localsIsAdmin`) AND
 * admin-scoped PAT/service tokens (via the shared `resolveBearerAdminPrincipal()`
 * helper).
 *
 * Usage:
 * export const GET = requireAdmin(async ({ locals }) => {
 *   // Admin-only logic here
 *   return json(data);
 * });
 */
export function requireAdmin(handler: RequestHandler): RequestHandler {
    return async (event: RequestEvent): Promise<Response> => {
        const endpoint = getEndpointName(event);

        try {
            // Primary path: the resolved credential's admin verdict (the principal
            // when there is one, never the token owner's flag alone).
            // A delegateToAdmin() handoff carries the outer gate's decision.
            let isAdmin = localsIsAdmin(event.locals) || isDelegatedAdmin(event);

            // Fallback path: admin-scoped PAT or service token. Runs when
            // `locals.user` is absent (Bearer-only client hitting a
            // `/api/admin/*` route that resolveAuth routes through
            // `handleForwardAuth` rather than `handlePublicApiAuth`) OR when
            // the session user is present but not admin (avoids a redundant DB
            // hit in that case via the short-circuit below).
            //
            // R5: resolve the Bearer credential's full Principal via the
            // shared resolveBearerAdminPrincipal() helper (the same one
            // mount.ts's {kind:'admin'} TERTIARY fallback uses) and, when one resolves
            // and `locals.principal` is not already set, materialise it onto
            // `event.locals`. This is a `/api/admin/*` route that never went
            // through mount()'s {kind:'admin'} TERTIARY fallback, so without
            // this an `auditLog()` call inside `handler` would fall through
            // `auditActor()`'s `principalBeforeDelegation ?? locals.principal
            // ?? locals.user` all the way to `{username: null}` →
            // `actor:'system'`, unattributable — the exact scenario R5 closes
            // for mount()-routed defs. Never overwrites an existing
            // `locals.principal`.
            // Only without a principal: a request carries ONE credential verdict.
            // A second lookup used to let a non-admin session plus an admin
            // Bearer header pass this gate while the handler (localsIsAdmin) saw
            // the non-admin principal.
            if (!isAdmin && !event.locals.principal) {
                const { resolveBearerAdminPrincipal } =
                    await import('$lib/server/auth/resolve-bearer-principal.js');
                const bearerPrincipal = await resolveBearerAdminPrincipal(event);
                if (bearerPrincipal) {
                    event.locals.principal = bearerPrincipal;
                    isAdmin = bearerPrincipal.isAdmin;
                }
            }

            if (!isAdmin) {
                logger.warn('Admin access denied', {
                    endpoint,
                    user: event.locals.user?.username,
                    groups: event.locals.user?.userGroups,
                });

                return ApiResponses.forbidden('Insufficient permissions', endpoint);
            }

            // User is admin, proceed to handler
            return await handler(event);
        } catch (error) {
            if (error instanceof AuthDependencyUnavailableError) return authUnavailableResponse();
            logger.error('Error checking admin status', error as Error, {
                endpoint,
            });
            return ApiResponses.error(
                'Authentication system error',
                error instanceof Error ? error : new Error('Unknown error'),
                500,
                endpoint,
            );
        }
    };
}

/**
 * Require user authentication (any valid user)
 */
export function requireAuth(handler: RequestHandler): RequestHandler {
    return async (event: RequestEvent): Promise<Response> => {
        const endpoint = getEndpointName(event);

        // Check if user is authenticated
        const user = event.locals.user;

        if (!user || !user.username) {
            logger.debug('Authentication required', { endpoint });

            // For browser requests, set redirect header for client-side handling
            if (event.request.headers.get('accept')?.includes('text/html')) {
                // HTML request - browser navigation, redirect immediately
                return new Response(null, {
                    status: 302,
                    headers: { Location: '/' },
                });
            }

            // For WebVTT requests (subtitle files), return empty valid WebVTT with 401
            // This prevents AVPlayer from trying to parse JSON error as WebVTT
            // which would cause error -12783 (AVErrorMalformedDocument)
            const url = new URL(event.request.url);
            if (url.pathname.endsWith('.vtt')) {
                logger.debug('Returning empty WebVTT for unauthenticated subtitle request', {
                    endpoint,
                    path: url.pathname,
                });
                return new Response('WEBVTT\n\n', {
                    status: 401,
                    headers: {
                        'Content-Type': 'text/vtt',
                        'X-Auth-Required': 'true',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            }

            // API request - return 401 with header for client handling
            return ApiResponses.unauthorized(
                'Authentication required for this operation',
                endpoint,
            );
        }

        // User is authenticated, proceed to handler
        return await handler(event);
    };
}

/**
 * Require specific user groups.
 *
 * WARNING (jellyfin_compat PAT interaction): this middleware checks
 * `locals.user.userGroups`, NOT `locals.user.isAdmin`. The PAT auth path in
 * `withJellyfinAuth` forces `isAdmin: false` but preserves the user's actual
 * group membership — so if a `/j/*` route uses `requireGroups(['admin'])`
 * (instead of `if (!locals.user.isAdmin)`), an admin-group user authenticated
 * via PAT WILL pass the check, defeating the PAT scope-reduction guarantee.
 *
 * For `/j/*` routes that must be session-only, use `withJellyfinAuth(handler,
 * { pat: 'deny' })` and/or in-handler `if (!locals.user.isAdmin)`. Do NOT rely
 * on `requireGroups(['admin'])` alone.
 */
export function requireGroups(requiredGroups: string[]) {
    return function (handler: RequestHandler): RequestHandler {
        return async (event: RequestEvent): Promise<Response> => {
            const endpoint = getEndpointName(event);

            const user = event.locals.user;
            if (!user || !user.username) {
                return ApiResponses.unauthorized('Authentication required', endpoint);
            }

            const userGroups = user.userGroups || [];
            // Case-insensitive group matching
            const userGroupsLower = userGroups.map((g) => g.toLowerCase());
            const hasRequiredGroup = requiredGroups.some((group) =>
                userGroupsLower.includes(group.toLowerCase()),
            );

            if (!hasRequiredGroup) {
                logger.warn('Group access denied', {
                    endpoint,
                    user: user.username,
                    userGroups,
                    requiredGroups,
                });

                return ApiResponses.forbidden('Insufficient permissions', endpoint);
            }

            // User has required group, proceed to handler
            return await handler(event);
        };
    };
}

/**
 * Require watch permissions (uses WATCH_PERMISSION_GROUPS from environment)
 */
export function requireWatchPermissions(handler: RequestHandler): RequestHandler {
    return async (event: RequestEvent): Promise<Response> => {
        const endpoint = getEndpointName(event);

        const user = event.locals.user;
        if (!user || !user.username) {
            return ApiResponses.unauthorized('Authentication required', endpoint);
        }

        try {
            const { config } = await import('$lib/server/config');
            const watchPermissionGroups: string[] = Array.isArray(config.WATCH_PERMISSION_GROUPS)
                ? config.WATCH_PERMISSION_GROUPS
                : [];

            if (watchPermissionGroups.length === 0) {
                logger.debug(
                    'WATCH_PERMISSION_GROUPS not configured, allowing all authenticated users',
                );
                return await handler(event);
            }

            const userGroups = user.userGroups || [];
            // Case-insensitive group matching
            const userGroupsLower = userGroups.map((g) => g.toLowerCase());
            const hasWatchPermission = watchPermissionGroups.some((group: string) =>
                userGroupsLower.includes(group.toLowerCase()),
            );

            if (!hasWatchPermission) {
                logger.warn('Watch permission denied', {
                    endpoint,
                    user: user.username,
                    userGroups,
                    requiredGroups: watchPermissionGroups,
                });

                return ApiResponses.forbidden('Insufficient permissions', endpoint);
            }

            // User has watch permissions, proceed to handler
            return await handler(event);
        } catch (error) {
            logger.error('Error checking watch permissions', error as Error, {
                endpoint,
            });
            return ApiResponses.error(
                'Authentication system error',
                error instanceof Error ? error : new Error('Unknown error'),
                500,
                endpoint,
            );
        }
    };
}

/**
 * Optional auth - allows both authenticated and anonymous users
 * Populates user context if available but doesn't block anonymous access
 */
export function optionalAuth(handler: RequestHandler): RequestHandler {
    return async (event: RequestEvent): Promise<Response> => {
        // Always proceed - user context is available in event.locals.user if authenticated
        return await handler(event);
    };
}

/**
 * Validate user ID parameter matches authenticated user (for user-specific operations)
 */
export function requireSelfOrAdmin(userIdParam: string = 'userId') {
    return function (handler: RequestHandler): RequestHandler {
        return async (event: RequestEvent): Promise<Response> => {
            const endpoint = getEndpointName(event);

            const user = event.locals.user;
            if (!user || !user.username) {
                return ApiResponses.unauthorized('Authentication required', endpoint);
            }

            // Get user ID from URL parameters
            const requestedUserId = (event.params as Record<string, string | undefined>)[
                userIdParam
            ];

            if (!requestedUserId) {
                return ApiResponses.badRequest(
                    'User ID parameter is required',
                    undefined,
                    endpoint,
                );
            }

            // Special case: "user" is a placeholder meaning "current authenticated user"
            // This allows endpoints to use /api/.../user as a shorthand for /api/.../[username]
            const isGenericUserParam = requestedUserId === 'user';

            // Check if user is accessing their own data or is admin.
            // Case-folded: forward-auth lowercases the authenticated username but
            // the path param keeps the caller's spelling, so a mixed-case name
            // otherwise failed to match itself. See the same note in mount.ts.
            const isOwnData =
                user.username.toLowerCase() === requestedUserId.toLowerCase() || isGenericUserParam;

            if (!isOwnData) {
                if (!localsIsAdmin(event.locals)) {
                    return ApiResponses.forbidden(
                        'You can only access your own data unless you have admin privileges',
                        endpoint,
                    );
                }
            }

            // User can access the data, proceed to handler
            return await handler(event);
        };
    };
}

/**
 * Rate limiting middleware (basic implementation)
 */
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

export function withRateLimit(
    maxRequests = 100,
    windowMs = 60000, // 1 minute
    keyGenerator?: (event: RequestEvent) => string,
) {
    return function (handler: RequestHandler): RequestHandler {
        return async (event: RequestEvent): Promise<Response> => {
            const endpoint = getEndpointName(event);

            // Generate rate limit key (IP + user or just IP)
            const defaultKey = `${getClientIp(event)}:${event.locals.user?.username || 'anonymous'}`;
            const key = keyGenerator ? keyGenerator(event) : defaultKey;

            const now = Date.now();
            const userLimit = rateLimitStore.get(key);

            if (userLimit) {
                if (now < userLimit.resetTime) {
                    // Within rate limit window
                    if (userLimit.count >= maxRequests) {
                        return ApiResponses.rateLimited(userLimit.resetTime, endpoint);
                    } else {
                        userLimit.count++;
                    }
                } else {
                    // Reset window
                    rateLimitStore.set(key, {
                        count: 1,
                        resetTime: now + windowMs,
                    });
                }
            } else {
                // First request
                rateLimitStore.set(key, {
                    count: 1,
                    resetTime: now + windowMs,
                });
            }

            // Clean up old entries periodically
            if (Math.random() < 0.01) {
                // 1% chance to cleanup
                const cutoff = now - windowMs;
                for (const [k, v] of rateLimitStore.entries()) {
                    if (v.resetTime < cutoff) {
                        rateLimitStore.delete(k);
                    }
                }
            }

            return await handler(event);
        };
    };
}

/**
 * Combine multiple middleware functions
 */
export function withMiddleware(...middlewares: ((handler: RequestHandler) => RequestHandler)[]) {
    return function (handler: RequestHandler): RequestHandler {
        return middlewares.reduceRight((acc, middleware) => middleware(acc), handler);
    };
}

/**
 * Common middleware combinations
 */
export const withAdminAuth = (handler: RequestHandler) =>
    withMiddleware(requireAuth, requireAdmin)(handler);

export const withUserAuth = (handler: RequestHandler) => withMiddleware(requireAuth)(handler);

export const withAdminRateLimit = (handler: RequestHandler) =>
    withMiddleware(requireAuth, requireAdmin, withRateLimit(50, 60000))(handler);

/**
 * Helper to extract user context from request
 */
export function getUserContext(event: RequestEvent): {
    username: string | null;
    userGroups: string[];
    isAuthenticated: boolean;
    isAdmin: boolean | null; // null means not checked yet
} {
    const user = event.locals.user;

    return {
        username: user?.username || null,
        userGroups: user?.userGroups || [],
        isAuthenticated: !!(user && user.username),
        isAdmin: null, // Will be checked when needed
    };
}
