// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OIDC Back-Channel Logout orchestration.
 *
 * Validates the logout token (§2.6), guards against jti replay (Valkey SET NX),
 * then revokes local sessions: by (iss, sid) for a session-scoped logout, else all
 * of the End-User's sessions by (iss, sub). A sub-scoped logout optionally cascades
 * to refresh + Jellyfin device tokens when AUTH_OIDC_BACKCHANNEL_LOGOUT_CASCADE is
 * set — NEVER for a sid-scoped logout (one OP session != all the user's devices).
 *
 * AGPL-core.
 */

import { createHash } from 'node:crypto';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    setIfNotExists,
    cacheDel,
    cacheExists,
    isValkeyReadyFor,
} from '$lib/server/cache/valkey.js';
import { getSessionService } from '$lib/server/services/session.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    validateLogoutTokenFromConfig,
    LogoutTokenError,
    type LogoutTokenClaims,
} from '$lib/server/services/oidc-logout-token.js';

const logger = Logger.for('OIDC:bcl');

/** jti replay window. Logout tokens are short-lived; 10 min covers exp + skew. */
const JTI_TTL_SECONDS = 600;

export interface BackchannelLogoutOutcome {
    revoked: number;
    scope: 'sid' | 'sub' | 'replayed';
}

function jtiKey(claims: LogoutTokenClaims): string {
    // Namespace by issuer so two OPs can't collide on jti; hash to bound length.
    // JSON.stringify([iss, jti]) gives an unambiguous encoding — a space-delimited
    // concatenation would let two (iss, jti) pairs that differ only by where a space
    // falls produce identical hash inputs.
    const h = createHash('sha256')
        .update(JSON.stringify([claims.iss, claims.jti]))
        .digest('hex');
    return `oidc:bcl:jti:v1:${h}`;
}

async function cascadeDeviceTokens(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    try {
        const { getJellyfinTokenService } =
            await import('$lib/server/oauth/jellyfin-token.service.js');
        const jellyfin = getJellyfinTokenService();
        // Per-user try/catch: one user's failure must not skip the others.
        for (const userId of userIds) {
            try {
                // userIds come from user_sessions.user_id (valid users.id UUIDs).
                await jellyfin.revokeAllForUser(toUserId(userId));
            } catch (error) {
                logger.warn('cascade: jellyfin revoke failed for user', {
                    userId,
                    error: String(error),
                });
            }
        }
    } catch (error) {
        logger.warn('cascade: jellyfin token service unavailable', { error: String(error) });
    }
    try {
        const { isDeviceAuthEnabled, getRefreshTokenService } =
            await import('$lib/server/oauth/index.js');
        if (isDeviceAuthEnabled()) {
            const refresh = getRefreshTokenService();
            for (const userId of userIds) {
                try {
                    await refresh.revokeAllForUser(toUserId(userId));
                } catch (error) {
                    logger.warn('cascade: refresh revoke failed for user', {
                        userId,
                        error: String(error),
                    });
                }
            }
        }
    } catch (error) {
        logger.warn('cascade: refresh token service unavailable', { error: String(error) });
    }
}

/**
 * Process one back-channel logout request. Throws LogoutTokenError on any
 * validation failure (the route maps that to HTTP 400). On a replayed jti it
 * returns an idempotent no-op success so the OP's retry isn't treated as a failure.
 */
export async function processBackchannelLogout(jwt: string): Promise<BackchannelLogoutOutcome> {
    // Throws LogoutTokenError (bad token → 400) or OidcBackchannelInfraError
    // (JWKS/discovery outage → 503). Both propagate to the route.
    const claims = await validateLogoutTokenFromConfig(jwt);

    // Replay guard — atomic check-and-set, but strictly FAIL-OPEN. setIfNotExists
    // returns false both when the key already exists AND when Valkey is down, so we
    // gate on isValkeyReadyFor(key) first. But that is only a synchronous
    // presence check — the SET NX can still fail at runtime (reconnect storm,
    // mid-call drop), and setIfNotExists swallows that and ALSO returns false. A
    // false therefore does NOT prove a replay. We only skip when we can CONFIRM the
    // key is actually present (a genuine replay); otherwise we fail open and revoke,
    // so a transient Valkey blip can never silently swallow a logout (which would
    // return 200 to the OP with the session still live and no retry). Revocation is
    // idempotent, so re-revoking on a false-negative confirm is harmless.
    const key = jtiKey(claims);
    // The jti marker lives on the task Valkey (`oidc:bcl:jti:`), so the guard
    // stays on while the optional cache is down or unset.
    const guardActive = isValkeyReadyFor(key);
    if (guardActive) {
        const fresh = await setIfNotExists(key, '1', JTI_TTL_SECONDS);
        if (!fresh && (await cacheExists(key))) {
            logger.info('Ignoring replayed logout token (jti seen)', { iss: claims.iss });
            return { revoked: 0, scope: 'replayed' };
        }
        if (!fresh) {
            logger.warn('Replay-guard SET returned false but key absent — failing open', {
                iss: claims.iss,
            });
        }
    }

    try {
        const sessions = getSessionService();

        // sid-scoped: one specific OP session. Never cascades.
        if (claims.sid) {
            const revoked = await sessions.revokeByOidcSession({
                iss: claims.iss,
                sid: claims.sid,
            });
            return { revoked, scope: 'sid' };
        }

        // sub-scoped: the whole End-User. The validator enforces sub || sid, and
        // sid is absent here — guard explicitly rather than relying on the cast.
        if (!claims.sub) {
            throw new LogoutTokenError('logout token reached sub-scope path without sub');
        }
        const { count, userIds } = await sessions.revokeByOidcSubject({
            iss: claims.iss,
            sub: claims.sub,
        });
        if (config.AUTH_OIDC_BACKCHANNEL_LOGOUT_CASCADE) {
            await cascadeDeviceTokens(userIds);
        }
        return { revoked: count, scope: 'sub' };
    } catch (error) {
        // Revocation failed (e.g. DB down). Release the jti marker so the OP's
        // retry isn't mistaken for a replay and dropped.
        if (guardActive) await cacheDel(key).catch(() => {});
        throw error;
    }
}
