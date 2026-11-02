// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/oauth/authorize - User approves device authorization
// DELETE /api/oauth/authorize - User denies device authorization
// This endpoint is behind forward auth - user is already authenticated via Authentik

import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { checkDeviceApprovalRateLimit } from '$lib/server/oauth/device-approval-rate-limit';
import { normalizeUserCode, redactUserCode } from '$lib/server/oauth/device-code.service';
import { z } from 'zod';
import { typedJson } from '$lib/server/utils/typed-response.js';
import type { RequestHandler } from './$types';
import {
    getDeviceCodeService,
    isDeviceAuthEnabled,
    getJellyfinPermissionsService,
} from '$lib/server/oauth';
import { getDb } from '$lib/server/database/connection.js';
import { operationMode } from '$lib/server/operation-mode.js';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { withValidation } from '$lib/server/middleware/validate';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { userCodeBodySchema } from '$lib/schemas/common';
import { syncUserGroups } from '$lib/server/services/user-groups.service.js';

const logger = Logger.for('OAuth:AuthorizeEndpoint');

const DeviceAuthorizeResponseSchema = z
    .object({
        success: z.boolean(),
        message: z.string(),
    })
    .passthrough();

/**
 * POST - Approve device authorization
 * User code comes from request body
 * Username and groups come from Authentik headers (via locals.user)
 *
 * Fix round 1, finding 3: the feature-enabled and auth checks now run BEFORE
 * `withValidation()` (outside it, not inside the wrapped handler) so an
 * anonymous or feature-disabled caller is rejected before the body is ever
 * read — `withValidation()` still buffers up to its size cap even for a
 * request that will ultimately fail these checks.
 */
export const POST: RequestHandler = withErrorHandler(async (event) => {
    // Check if device auth is enabled
    if (!isDeviceAuthEnabled()) {
        return ApiResponses.badRequest('Device authorization is not enabled');
    }

    // User must be authenticated (forward auth)
    if (!event.locals.user?.username) {
        return ApiResponses.unauthorized();
    }

    return withValidation(
        async ({ validated, locals }) => {
            // Re-narrow `locals.user` for TypeScript — the runtime check
            // already ran in the outer handler above (same `event`), so this
            // is unreachable in practice; it exists only because that guard
            // lives in a different function scope than this one.
            const user = locals.user;
            if (!user?.username) {
                return ApiResponses.unauthorized();
            }

            try {
                const user_code = normalizeUserCode(validated.body.user_code);
                const limited = await checkDeviceApprovalRateLimit(
                    user.userId,
                    user_code,
                    getClientIpStrict(event),
                );
                if (limited) return limited;

                const username = user.username;
                // Device codes are keyed by the stable users.id UUID (mig 16.46.0).
                const userId = user.userId;

                // Verify device code exists and is pending
                const deviceCodeService = getDeviceCodeService();
                const record = await deviceCodeService.getByUserCode(user_code);

                if (!record) {
                    return ApiResponses.notFound('Invalid or expired device code');
                }

                if (record.status !== 'pending') {
                    return ApiResponses.notFound('Invalid or expired device code');
                }

                // Get the database connection
                const sql = getDb();
                if (!sql) {
                    return ApiResponses.error('Database not initialized');
                }

                // Cache the user's Authentik groups, and invalidate the
                // admin/max-age caches this write feeds (security review 5,
                // C4 + Shape C). Only forward-auth writes here, and only the
                // raw IdP projection (`locals.idpGroups`) — NOT
                // `user.userGroups`, which is the MERGED set (IdP header
                // groups union in-app group names). Writing the merged set
                // baked in-app group names (including a name that happens to
                // equal an ADMIN_GROUPS entry) into `users.groups`, which
                // every token path reads as the IdP projection — so removing
                // a user from an in-app library or admin-conferring group
                // never reached those surfaces (security review 6, P2). A
                // native or OIDC session's `users.groups` is already the
                // stored projection written by its own login path, so this
                // route writing it again would be redundant at best and the
                // bug at worst; skip it for every auth method but
                // forward-auth. The forward-auth write is kept (not simply
                // left to forward-auth's own `syncUserGroupsIfNeeded`)
                // because that sync is fire-and-forget and hash-throttled: it
                // can still be in flight when the device token is issued, and
                // it skips an unchanged header list for its whole TTL even if
                // another writer changed the column since. This awaited write
                // puts the IdP's current list in place before the token that
                // will be resolved against it exists.
                // An EMPTY list is written too (the IdP revoked every group);
                // `undefined` (groups header absent) never writes, or a proxy
                // that does not forward it would clear age-cap groups.
                if (locals.authMethod === 'forward_auth' && locals.idpGroups !== undefined) {
                    await syncUserGroups(sql, username, locals.idpGroups);
                }

                // Cache Jellyfin permissions only when Jellyfin sync is enabled
                if (operationMode.isJellyfinEnabled && features.jellyfinSync) {
                    const permissionsService = getJellyfinPermissionsService();
                    await permissionsService.fetchAndCachePermissions(username);
                }

                // Authorize the device code
                const success = await deviceCodeService.authorize(user_code, userId);

                if (!success) {
                    return ApiResponses.notFound('Invalid or expired device code');
                }

                logger.info('Device authorized', {
                    username,
                    userCode: redactUserCode(user_code),
                    clientId: record.client_id,
                });

                return typedJson(DeviceAuthorizeResponseSchema, {
                    success: true,
                    message: 'Device authorized successfully',
                });
            } catch (error) {
                logger.error(
                    'Failed to authorize device',
                    error instanceof Error ? error : undefined,
                );
                return ApiResponses.error('Failed to authorize device', undefined, 500);
            }
        },
        { body: userCodeBodySchema },
    )(event);
});

/**
 * DELETE - Deny device authorization
 *
 * Fix round 1, finding 3: same reordering as POST above — feature-enabled and
 * auth checks run before `withValidation()`, not inside it.
 */
export const DELETE: RequestHandler = withErrorHandler(async (event) => {
    // Check if device auth is enabled
    if (!isDeviceAuthEnabled()) {
        return ApiResponses.badRequest('Device authorization is not enabled');
    }

    // User must be authenticated (forward auth)
    if (!event.locals.user?.username) {
        return ApiResponses.unauthorized();
    }

    return withValidation(
        async ({ validated, locals }) => {
            // Re-narrow for TypeScript — see the identical comment on POST above.
            const user = locals.user;
            if (!user?.username) {
                return ApiResponses.unauthorized();
            }

            try {
                const user_code = normalizeUserCode(validated.body.user_code);
                const limited = await checkDeviceApprovalRateLimit(
                    user.userId,
                    user_code,
                    getClientIpStrict(event),
                );
                if (limited) return limited;

                const deviceCodeService = getDeviceCodeService();

                // Check current status for idempotency
                const record = await deviceCodeService.getByUserCode(user_code);
                if (!record) {
                    return ApiResponses.notFound('Invalid or expired device code');
                }

                if (record.status !== 'pending') {
                    return ApiResponses.notFound('Invalid or expired device code');
                }

                const success = await deviceCodeService.deny(user_code, user.userId);

                if (!success) {
                    return ApiResponses.notFound('Invalid or expired device code');
                }

                logger.info('Device denied', {
                    username: user.username,
                    userCode: redactUserCode(user_code),
                });

                return typedJson(DeviceAuthorizeResponseSchema, {
                    success: true,
                    message: 'Device authorization denied',
                });
            } catch (error) {
                logger.error('Failed to deny device', error instanceof Error ? error : undefined);
                return ApiResponses.error('Failed to deny device', undefined, 500);
            }
        },
        { body: userCodeBodySchema },
    )(event);
});
