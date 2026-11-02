// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Server-side logout handler
 *
 * POST /logout
 *
 * Revokes the CURRENT session's device tokens before the client redirects to
 * Authentik logout.
 *
 * ## Scope: this session, not this account
 *
 * This used to call `revokeAllForUser()` for both Jellyfin tokens and OAuth
 * refresh tokens, which signed the user out of every device they owned. Signing
 * out of a browser tab would kill the refresh token on their iPhone, iPad and
 * Apple TV, and those devices had no way to tell that from a session that had
 * genuinely expired — they just showed a login screen at random. Nothing about
 * "log out" implies "log out everywhere"; the UI for that already exists
 * separately (DELETE /api/v1/devices/{id}, and the revoke-all endpoints).
 *
 * A browser session is not a device session at all: `locals.deviceSessionId` is
 * set only for Bearer-token auth. So for the ordinary web logout this endpoint
 * now correctly revokes NO device tokens — the browser's own session is ended by
 * the cookie clearing and the Authentik redirect that follow this call. It still
 * does the right thing if a Bearer-authenticated client posts here, revoking
 * exactly that one session.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger.js';
import { withClearSiteData } from '$lib/server/utils/clear-site-data.js';

const logger = Logger.for('Logout');

export const POST: RequestHandler = async ({ locals }) => {
    const username = locals.user?.username;
    const userId = locals.user?.userId;

    if (!username || !userId) {
        // Not authenticated - nothing to revoke
        return withClearSiteData(json({ success: true, revoked: 0 }));
    }

    const deviceSessionId = locals.deviceSessionId;

    if (!deviceSessionId) {
        // A browser/forward-auth session. It owns no device tokens, so there is
        // nothing here to revoke — and revoking the account's OTHER devices would
        // be actively wrong.
        logger.info('Logout with no device session; no device tokens revoked', {
            username,
        });
        return withClearSiteData(
            json({
                success: true,
                revoked: { jellyfinTokens: 0, refreshTokens: 0 },
            }),
        );
    }

    let jellyfinTokensRevoked = 0;
    let refreshTokensRevoked = 0;

    try {
        const { getJellyfinTokenService } =
            await import('$lib/server/oauth/jellyfin-token.service.js');
        const jellyfinTokenService = getJellyfinTokenService();
        jellyfinTokensRevoked = (await jellyfinTokenService.revoke(deviceSessionId, userId))
            ? 1
            : 0;
    } catch (error) {
        // Log but don't fail - user should still be able to logout
        logger.warn('Failed to revoke Jellyfin token on logout', {
            username,
            error: String(error),
        });
    }

    try {
        const { isDeviceAuthEnabled, getRefreshTokenService } =
            await import('$lib/server/oauth/index.js');

        if (isDeviceAuthEnabled()) {
            // Revoke the whole device_session_id family, not a single token hash:
            // since 16.218.0 a session can legitimately hold more than one live
            // refresh token (the current one plus a superseded predecessor that is
            // still valid), and leaving either behind would leave the "logged out"
            // device able to refresh.
            refreshTokensRevoked =
                await getRefreshTokenService().revokeByDeviceSessionId(deviceSessionId);
        }
    } catch (error) {
        logger.warn('Failed to revoke refresh tokens on logout', {
            username,
            error: String(error),
        });
    }

    logger.info('Device session logged out', {
        username,
        deviceSessionId: deviceSessionId.substring(0, 8) + '...',
        jellyfinTokensRevoked,
        refreshTokensRevoked,
    });

    return withClearSiteData(
        json({
            success: true,
            revoked: {
                jellyfinTokens: jellyfinTokensRevoked,
                refreshTokens: refreshTokensRevoked,
            },
        }),
    );
};
