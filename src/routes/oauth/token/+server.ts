// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /oauth/token - Exchange device code or refresh token for access token
// This is a public endpoint (no authentication required)
// Rate limited to prevent brute force attacks on device codes and refresh tokens

import { DeviceSessionRevokedError } from '$lib/server/oauth/device-session-errors.js';
import { readBoundedBodyText, BODY_TOO_LARGE } from '$lib/server/utils/bounded-body-reader';
import { json } from '@sveltejs/kit';
import { createHash } from 'crypto';
import type { RequestHandler } from './$types';
import {
    getDeviceCodeService,
    getRefreshTokenService,
    generateAccessToken,
    isDeviceAuthEnabled,
} from '$lib/server/oauth';
import { Logger } from '$lib/server/utils/logger';
import { tokenDeviceCodeGrantSchema, tokenRefreshGrantSchema } from '$lib/schemas/oauth.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { getClientIpStrictFromRequest } from '$lib/server/utils/client-ip';
import { getTcpPeer } from '$lib/server/utils/tcp-peer';
import { toUserId } from '$lib/shared/user-id';
import {
    reportDeviceName,
    resolveExistingDeviceSession,
} from '$lib/server/services/user-devices.service';

const logger = Logger.for('OAuth:TokenEndpoint');

/**
 * Return an opaque 8-hex-char identifier derived from a secret value.
 * Safe to log: reveals nothing about the plaintext beyond its identity.
 * Mirrors the same approach used in device-code.service.ts.
 */
function opaquePrefix(secret: string): string {
    return createHash('sha256').update(secret).digest('hex').slice(0, 8) + '...';
}

// Per-IP rate limiting: 30 requests per minute (higher than /device since clients poll)
const IP_RATE_LIMIT_MAX_REQUESTS = 30;
const IP_RATE_LIMIT_WINDOW_SECONDS = 60;

// RFC 6749 §5.1 / §5.2: token responses MUST carry Cache-Control: no-store
const TOKEN_RESPONSE_HEADERS = { 'Cache-Control': 'no-store' };

/**
 * Stable, machine-readable failure codes returned alongside the RFC 6749
 * `error` field as `code`.
 *
 * RFC 6749 only has `invalid_grant`, which this endpoint returns for everything
 * from a malformed device code to a revoked session, and `error_description` is
 * prose that clients should not be switching on. Without something stable, a
 * client cannot tell "retry, your session is fine" from "sign the user out" —
 * so it guesses, and the iOS app guessed "sign out" for all of them.
 *
 * These values are API surface. Add to them freely; do not repurpose or rename
 * one without treating it as a breaking change for every shipped client.
 */
const ERROR_CODES = {
    /** Device authorization is switched off server-side. */
    DEVICE_AUTH_DISABLED: 'device_auth_disabled',
    /** Body was not a recognised grant. */
    UNSUPPORTED_GRANT: 'unsupported_grant',
    /** Per-IP rate limit. Retry after the Retry-After interval. */
    RATE_LIMITED: 'rate_limited',
    /** Device code is unknown, already consumed, or expired. */
    DEVICE_CODE_INVALID: 'device_code_invalid',
    /** Device code is valid; the user has not approved it yet. Keep polling. */
    AUTHORIZATION_PENDING: 'authorization_pending',
    /** Polling faster than the advertised interval. */
    SLOW_DOWN: 'slow_down',
    /** The user declined the authorization. */
    ACCESS_DENIED: 'access_denied',
    /** Device code expired before approval. Start a new device flow. */
    DEVICE_CODE_EXPIRED: 'device_code_expired',
    /** client_id does not match the one the token was issued to. */
    CLIENT_MISMATCH: 'client_mismatch',
    /**
     * The refresh token is not usable and the session is over: unknown, revoked
     * by a logout or an admin, or past its absolute expiry. Sign the user out
     * and re-run the device flow.
     *
     * Since 16.218.0 a rotation race no longer lands here — concurrent refreshes
     * both succeed against the still-valid superseded token, and a retry of a
     * lost rotation is replayed. So on the refresh path this code, and the two
     * more specific ones below, now genuinely mean "signed out", which is what
     * makes them safe for a client to act on.
     */
    REFRESH_TOKEN_INVALID: 'refresh_token_invalid',
    /** More specific than the above: the row was explicitly revoked. Terminal. */
    REFRESH_TOKEN_REVOKED: 'refresh_token_revoked',
    /** More specific than the above: the row passed its expiry. Terminal. */
    REFRESH_TOKEN_EXPIRED: 'refresh_token_expired',
    /** Server-side fault. Retryable. */
    SERVER_ERROR: 'server_error',
    /** Request body exceeded MAX_OAUTH_BODY_BYTES (C15). */
    PAYLOAD_TOO_LARGE: 'payload_too_large',
} as const;

// ============================================================================
// Body parsing — RFC 8628 §3.4 requires form-urlencoded; accept both
// ============================================================================

/**
 * A grant body is a handful of short opaque strings (codes, tokens, a
 * client_id) — never legitimately large. Matches mount.ts's DEFAULT_MAX_BODY_BYTES
 * so this unauthenticated, bypass-auth surface (C15) is bounded the same as
 * every def on the v1 surface.
 */
const MAX_OAUTH_BODY_BYTES = 256 * 1024;

/** Thrown by parseOAuthBody() when the body exceeds MAX_OAUTH_BODY_BYTES. */
class OAuthBodyTooLargeError extends Error {}

/**
 * Parse the request body as either application/x-www-form-urlencoded or
 * application/json. Returns a plain object or throws on malformed input.
 * Off-the-shelf OAuth clients (TVs, CLIs) send form-urlencoded; the existing
 * JSON path is kept for compatibility with first-party clients.
 *
 * SIZE CAP (C15): a declared `Content-Length` over the cap is rejected before
 * any read; an honest-but-lying (or chunked, no Content-Length) body is caught
 * after buffering by checking the actual decoded length before parsing.
 */
async function parseOAuthBody(request: Request): Promise<unknown> {
    const declared = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_OAUTH_BODY_BYTES) {
        throw new OAuthBodyTooLargeError();
    }

    const ct = request.headers.get('content-type') ?? '';
    if (ct.includes('application/x-www-form-urlencoded')) {
        const text = await readBoundedBodyText(request, MAX_OAUTH_BODY_BYTES);
        if (text === BODY_TOO_LARGE) throw new OAuthBodyTooLargeError();
        const params = new URLSearchParams(text);
        const obj: Record<string, string> = {};
        for (const [key, value] of params.entries()) {
            obj[key] = value;
        }
        return obj;
    }

    const text = await readBoundedBodyText(request, MAX_OAUTH_BODY_BYTES);
    if (text === BODY_TOO_LARGE) throw new OAuthBodyTooLargeError();
    return JSON.parse(text);
}

// ============================================================================
// Endpoint Handler
// ============================================================================

export const POST: RequestHandler = async (event) => {
    const { request } = event;
    // Check if device auth is enabled
    if (!isDeviceAuthEnabled()) {
        return json(
            {
                error: 'invalid_request',
                error_description: 'Device authorization is not enabled',
                code: ERROR_CODES.DEVICE_AUTH_DISABLED,
            },
            { status: 400, headers: TOKEN_RESPONSE_HEADERS },
        );
    }

    // Get client IP for rate limiting
    const clientIp = getClientIpStrictFromRequest(request, () => getTcpPeer(event));

    // Distributed rate limit via Valkey (with in-memory fallback)
    const rateResult = await checkRateLimit(
        `oauth:token:${clientIp}`,
        IP_RATE_LIMIT_MAX_REQUESTS,
        IP_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!rateResult.allowed) {
        logger.warn('IP rate limit exceeded on token endpoint', {
            ip: clientIp,
        });
        return json(
            {
                error: 'slow_down',
                error_description: 'Too many requests. Please wait before trying again.',
                code: ERROR_CODES.RATE_LIMITED,
            },
            {
                status: 429,
                headers: { ...TOKEN_RESPONSE_HEADERS, 'Retry-After': '60' },
            },
        );
    }

    try {
        const body: unknown = await parseOAuthBody(request);

        // Try device code grant first
        const deviceCodeResult = tokenDeviceCodeGrantSchema.safeParse(body);
        if (deviceCodeResult.success) {
            return await handleDeviceCodeGrant(deviceCodeResult.data);
        }

        // Try refresh token grant
        const refreshTokenResult = tokenRefreshGrantSchema.safeParse(body);
        if (refreshTokenResult.success) {
            return await handleRefreshTokenGrant(refreshTokenResult.data);
        }

        // Neither grant type matched
        const grantType =
            typeof body === 'object' &&
            body !== null &&
            'grant_type' in body &&
            typeof (body as Record<string, unknown>).grant_type === 'string'
                ? (body as Record<string, unknown>).grant_type
                : 'unknown';

        return json(
            {
                error: 'unsupported_grant_type',
                error_description: `Unsupported grant type: ${grantType}`,
                code: ERROR_CODES.UNSUPPORTED_GRANT,
            },
            { status: 400, headers: TOKEN_RESPONSE_HEADERS },
        );
    } catch (error) {
        if (error instanceof DeviceSessionRevokedError) {
            return json(
                {
                    error: 'invalid_grant',
                    error_description: 'Device session is no longer authorized',
                    code: ERROR_CODES.DEVICE_CODE_INVALID,
                },
                { status: 400, headers: TOKEN_RESPONSE_HEADERS },
            );
        }
        if (error instanceof OAuthBodyTooLargeError) {
            return json(
                {
                    error: 'invalid_request',
                    error_description: 'Request body is too large',
                    code: ERROR_CODES.PAYLOAD_TOO_LARGE,
                },
                { status: 413, headers: TOKEN_RESPONSE_HEADERS },
            );
        }
        logger.error('Token endpoint error', error instanceof Error ? error : undefined);
        return json(
            {
                error: 'server_error',
                error_description: 'Internal server error',
                code: ERROR_CODES.SERVER_ERROR,
            },
            { status: 500, headers: TOKEN_RESPONSE_HEADERS },
        );
    }
};

/**
 * Handle device code grant (RFC 8628)
 * Client polls this endpoint after user scans QR code
 */
async function handleDeviceCodeGrant(body: {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code';
    device_code: string;
    client_id: string;
}) {
    const { device_code, client_id } = body;

    const deviceCodeService = getDeviceCodeService();
    const refreshTokenService = getRefreshTokenService();

    // Check for rate limiting (slow_down)
    if (await deviceCodeService.isPollTooFast(device_code)) {
        return json(
            {
                error: 'slow_down',
                error_description: 'Polling too frequently',
                code: ERROR_CODES.SLOW_DOWN,
            },
            { status: 400, headers: TOKEN_RESPONSE_HEADERS },
        );
    }

    // Record this poll attempt
    await deviceCodeService.recordPoll(device_code);

    // Get the device code record
    const record = await deviceCodeService.getByDeviceCode(device_code);

    if (!record) {
        logger.warn('DEVICE CODE REJECTED: Invalid or expired device code', {
            clientId: client_id,
            hint: 'Device code may have expired (15min TTL), already been used, or never existed',
        });
        return json(
            {
                error: 'invalid_grant',
                error_description: 'Invalid device code',
                code: ERROR_CODES.DEVICE_CODE_INVALID,
            },
            { status: 400, headers: TOKEN_RESPONSE_HEADERS },
        );
    }

    // Verify client_id matches
    if (record.client_id !== client_id) {
        logger.warn('DEVICE CODE CLIENT MISMATCH: client_id does not match device code', {
            expectedClientId: record.client_id,
            providedClientId: client_id,
            hint: 'Possible token theft attempt or client misconfiguration',
        });
        return json(
            {
                error: 'invalid_grant',
                error_description: 'Client ID mismatch',
                code: ERROR_CODES.CLIENT_MISMATCH,
            },
            { status: 400, headers: TOKEN_RESPONSE_HEADERS },
        );
    }

    // Check status
    switch (record.status) {
        case 'pending':
            // User hasn't authorized yet - client should keep polling
            return json(
                {
                    error: 'authorization_pending',
                    error_description: 'Authorization pending',
                    code: ERROR_CODES.AUTHORIZATION_PENDING,
                },
                { status: 400, headers: TOKEN_RESPONSE_HEADERS },
            );

        case 'denied':
            // User denied the request
            return json(
                {
                    error: 'access_denied',
                    error_description: 'User denied authorization',
                    code: ERROR_CODES.ACCESS_DENIED,
                },
                { status: 400, headers: TOKEN_RESPONSE_HEADERS },
            );

        case 'expired':
            // Device code has expired
            return json(
                {
                    error: 'expired_token',
                    error_description: 'Device code has expired',
                    code: ERROR_CODES.DEVICE_CODE_EXPIRED,
                },
                { status: 400, headers: TOKEN_RESPONSE_HEADERS },
            );

        case 'authorized':
            // User approved! Generate tokens
            break;

        default:
            return json(
                {
                    error: 'server_error',
                    error_description: 'Unknown device code status',
                    code: ERROR_CODES.SERVER_ERROR,
                },
                { status: 500, headers: TOKEN_RESPONSE_HEADERS },
            );
    }

    const issued = await deviceCodeService.exchangeAuthorized(
        device_code,
        client_id,
        async (record, dbConnection) => {
            // Get the user's groups and Jellyfin ID from the authorization record
            // These were stored when the user approved the device code
            // We need to fetch them from the database or cache

            // For now, we need to get the groups from the users table
            // and the jellyfin_user_id from user_jellyfin_permissions table
            // record.user_id is a users.id UUID (mig 16.46.0). Look up the user row by id
            // to get both the cached groups and the real username for the JWT claim.
            type UserGroupsRow = {
                username: string;
                groups: string[] | null;
                disabled_at: Date | null;
            };
            const groupsResult = await dbConnection<UserGroupsRow[]>`
                SELECT username, groups, disabled_at FROM users
                WHERE id = ${record.user_id}::uuid
            `;
            const groupRow = groupsResult[0];
            const groups = Array.isArray(groupRow?.groups) ? groupRow.groups : [];
            const username = groupRow?.username;
            // The caller already holds an approved device code. A disabled account
            // gets a terminal RFC 8628 denial that apps can explain to its owner.
            if (username && groupRow?.disabled_at) {
                return json(
                    { error: 'access_denied', error_description: 'account_disabled' },
                    { status: 400, headers: TOKEN_RESPONSE_HEADERS },
                );
            }
            if (!username) {
                logger.warn('Device code references unknown user id - rejecting', {
                    userId: record.user_id,
                });
                return json(
                    {
                        error: 'invalid_grant',
                        error_description: 'Invalid device code',
                        code: ERROR_CODES.DEVICE_CODE_INVALID,
                    },
                    { status: 400, headers: TOKEN_RESPONSE_HEADERS },
                );
            }

            // Get user's Jellyfin ID (user_library_permissions.user_id is a uuid now)
            type JellyfinUserRow = { provider_user_id: string | null };
            const jellyfinResult = await dbConnection<JellyfinUserRow[]>`
                SELECT provider_user_id FROM user_library_permissions
                WHERE user_id = ${record.user_id}::uuid
            `;

            const jellyfinUserId = jellyfinResult[0]?.provider_user_id ?? undefined;
            if (!jellyfinUserId) {
                logger.warn(
                    'Jellyfin user ID not found - issuing token without Jellyfin integration',
                    {
                        userId: record.user_id,
                    },
                );
            }

            // Check if this device_id already has a session for this user, and if so reuse
            // its device_session_id so a re-login continues the same device.
            //
            // This used to resolve against user_provider_device_tokens, which only has rows
            // when Jellyfin sync is enabled. On the default Jellyfin-less install the lookup
            // always missed, so every login minted a fresh device_session_id and the device
            // list grew one phantom entry per login. oauth_refresh_tokens exists on every
            // install, so continuity no longer depends on an optional integration.
            let deviceSessionId = record.device_session_id;

            if (record.device_id) {
                const existingSessionId = record.approved_by_device_session_id
                    ? null
                    : await resolveExistingDeviceSession(
                          dbConnection,
                          toUserId(record.user_id!),
                          record.device_id,
                      );

                if (existingSessionId) {
                    deviceSessionId = existingSessionId;
                    logger.info('Reusing existing device session', {
                        deviceId: record.device_id.substring(0, 8) + '...',
                        userId: record.user_id,
                        deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                    });
                } else {
                    logger.info('New device, creating fresh session', {
                        deviceId: record.device_id.substring(0, 8) + '...',
                        userId: record.user_id,
                        deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                    });
                }

                // Register the device and record the name the client reported at login.
                await reportDeviceName(dbConnection, {
                    userId: toUserId(record.user_id!),
                    deviceId: record.device_id,
                    name: record.device_name,
                    clientId: client_id,
                    source: 'oauth-device-flow',
                });
            }

            // Generate Jellyfin access token for this device via Quick Connect
            // This ensures playback sessions show the correct user, not the admin
            const { getJellyfinTokenService } =
                await import('$lib/server/oauth/jellyfin-token.service');
            const jellyfinTokenService = getJellyfinTokenService();

            // Create Jellyfin token in background (don't block token issuance)
            // The token will be ready by the time the client makes playback requests
            // Pass device_id so it's stored for future lookups
            // Only attempt if we have a Jellyfin user ID
            if (jellyfinUserId) {
                jellyfinTokenService
                    .getOrCreateToken({
                        userId: toUserId(record.user_id!),
                        jellyfinUserId,
                        deviceSessionId,
                        deviceName: record.device_name || undefined,
                        deviceId: record.device_id || undefined,
                    })
                    .catch((error) => {
                        // Log but don't fail - we can retry on first playback request
                        logger.warn('Failed to create Jellyfin token (will retry on playback)', {
                            userId: record.user_id,
                            error: String(error),
                        });
                    });
            }

            // Generate access token - include device_session_id for unique device identification
            // Note: jellyfinUserId is NOT included in the JWT — it's resolved lazily at point of use
            const accessToken = await generateAccessToken({
                username,
                clientId: client_id,
                scope: record.scope || undefined,
                groups,
                deviceSessionId,
            });

            // Create refresh token - preserve device_session_id for token rotations
            const refreshToken = await refreshTokenService.create(
                {
                    userId: toUserId(record.user_id!),
                    clientId: client_id,
                    scope: record.scope || undefined,
                    deviceName: record.device_name || undefined,
                    groups,
                    deviceSessionId,
                    deviceId: record.device_id ?? null,
                    approvedByDeviceSessionId: record.approved_by_device_session_id,
                },
                dbConnection,
            );

            logger.info('Tokens issued for device code', {
                userId: record.user_id,
                clientId: client_id,
                deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                reusedSession: deviceSessionId !== record.device_session_id,
            });

            // Return tokens per OAuth 2.0 spec
            const { config } = await import('$lib/server/config');
            return json(
                {
                    access_token: accessToken,
                    token_type: 'Bearer',
                    expires_in: config.JWT_ACCESS_TOKEN_TTL_SECONDS,
                    refresh_token: refreshToken,
                    scope: record.scope || undefined,
                },
                { headers: TOKEN_RESPONSE_HEADERS },
            );
        },
    );
    return (
        issued ??
        json(
            {
                error: 'invalid_grant',
                error_description: 'Invalid device code',
                code: ERROR_CODES.DEVICE_CODE_INVALID,
            },
            { status: 400, headers: TOKEN_RESPONSE_HEADERS },
        )
    );
}

/**
 * Handle refresh token grant
 * Client uses this to get a new access token without re-authorizing
 *
 * SECURITY: Token rotation is enabled — each refresh returns a NEW refresh token.
 * The presented token is superseded rather than revoked, and dies one rotation
 * later once its successor is actually used, so a client that never receives the
 * response is not permanently locked out. See RefreshTokenService.rotate().
 *
 * SECURITY (RFC 6749 §10.4): If client_id is provided in the request body, it is
 * verified against the client_id bound to the refresh token at issuance. Mismatches
 * are rejected with invalid_grant and logged as a security event.
 *
 * SECURITY (RFC 6819 §5.2.2.3): reuse detection is deliberately NOT implemented
 * here. The previous implementation could only ever fire on a legitimate client's
 * concurrent refresh — never on the delayed replay that actually signals theft —
 * so it destroyed real sessions and caught no attackers. Reinstating it requires
 * moving detection ahead of validate(); see the comment at the rotate() call.
 */
async function handleRefreshTokenGrant(body: {
    grant_type: 'refresh_token';
    refresh_token: string;
    client_id?: string;
}) {
    const { refresh_token, client_id } = body;

    const refreshTokenService = getRefreshTokenService();

    // Validate the refresh token
    const record = await refreshTokenService.validate(refresh_token);

    if (!record) {
        // CRITICAL: Log refresh token failures - this is often why playback breaks
        // after JWT expires and client tries to refresh
        logger.warn('REFRESH TOKEN REJECTED: Invalid or expired refresh token', {
            tokenPrefix: opaquePrefix(refresh_token),
            hint: 'Token may be expired (90d TTL), revoked, or already rotated. Client must re-authenticate via device flow.',
        });
        return json(
            {
                error: 'invalid_grant',
                error_description: 'Invalid or expired refresh token',
                code: ERROR_CODES.REFRESH_TOKEN_INVALID,
            },
            { status: 400, headers: TOKEN_RESPONSE_HEADERS },
        );
    }

    // RFC 6749 §10.4: If client_id was presented, verify it matches the client
    // that originally obtained this refresh token. Reject on mismatch to prevent
    // cross-client token use after exfiltration.
    if (client_id !== undefined && client_id !== record.client_id) {
        logger.warn('REFRESH TOKEN CLIENT MISMATCH: client_id does not match token binding', {
            tokenPrefix: opaquePrefix(refresh_token),
            tokenId: record.id,
            username: record.user_id,
            expectedClientId: record.client_id,
            providedClientId: client_id,
            hint: 'Possible refresh token exfiltration or client misconfiguration',
        });
        return json(
            {
                error: 'invalid_grant',
                error_description: 'client_id does not match token binding',
                code: ERROR_CODES.CLIENT_MISMATCH,
            },
            { status: 400, headers: TOKEN_RESPONSE_HEADERS },
        );
    }

    // record.user_id is a users.id UUID (mig 16.46.0); the JWT username claim must
    // carry the real username, so resolve the UUID → username before minting.
    const { getDb } = await import('$lib/server/database/connection.js');
    const sql = getDb();
    if (!sql) {
        return json(
            {
                error: 'server_error',
                error_description: 'Database not initialized',
                code: ERROR_CODES.SERVER_ERROR,
            },
            { status: 500, headers: TOKEN_RESPONSE_HEADERS },
        );
    }
    const userRows = await sql<{ username: string; disabled_at: Date | null }[]>`
        SELECT username, disabled_at FROM users WHERE id = ${record.user_id}::uuid
    `;
    const username = userRows[0]?.username;
    // A disabled account must not mint a fresh access token off an
    // already-issued refresh token (security review 2026-09-13, C2) — same
    // invalid_grant shape as a missing/unknown user, no enumeration.
    if (!username || userRows[0]?.disabled_at) {
        logger.warn('Refresh token references unknown or disabled user id - rejecting', {
            userId: record.user_id,
            disabled: Boolean(userRows[0]?.disabled_at),
        });
        return json(
            {
                error: 'invalid_grant',
                error_description: 'Invalid or expired refresh token',
                code: ERROR_CODES.REFRESH_TOKEN_INVALID,
            },
            { status: 400, headers: TOKEN_RESPONSE_HEADERS },
        );
    }

    // Generate new access token - include device_session_id for unique device identification
    // Note: jellyfinUserId is NOT included in the JWT — it's resolved lazily at point of use
    const accessToken = await generateAccessToken({
        username,
        clientId: record.client_id,
        scope: record.scope || undefined,
        groups: record.user_groups || [],
        deviceSessionId: record.device_session_id || undefined,
    });

    // Rotate the refresh token: issue a replacement and SUPERSEDE the presented one,
    // which stays valid until its own successor is used (migration 16.218.0). A retry
    // inside the replay window gets the identical token back.
    //
    // NO FAILURE HERE REVOKES THE DEVICE SESSION. This used to call
    // revokeByDeviceSessionId() on 'revoked' as RFC 6819 §5.2.2.3 reuse detection, and
    // that was exactly backwards: validate() above already rejects any token whose row
    // is revoked, so a genuinely replayed token never reached that branch. The only way
    // in was two concurrent refreshes from ONE legitimate client racing on the same
    // token — which then had its entire session destroyed, signing the user out of a
    // device that had done nothing wrong. Prod showed lumastra-ios issuing exactly such
    // back-to-back refreshes, 119-176ms apart. Under the supersede model both racers now
    // succeed, so this path no longer sees the race at all.
    //
    // Remaining reasons are all genuinely terminal, which is what lets a client act on
    // them without guessing:
    //   • 'revoked'   — revoked by a logout, an admin, or by rotating one step further.
    //   • 'expired'   — passed expires_at in the validate()/rotate() TOCTOU window.
    //   • 'not_found' — row already hard-deleted by cleanup.
    const rotateResult = await refreshTokenService.rotate(refresh_token);

    if (!rotateResult.ok) {
        logger.warn('REFRESH TOKEN REJECTED: rotation failed', {
            tokenPrefix: opaquePrefix(refresh_token),
            userId: record.user_id,
            deviceSessionId: record.device_session_id
                ? record.device_session_id.substring(0, 8) + '...'
                : 'none',
            reason: rotateResult.reason,
            hint: 'Session is over; client must re-authenticate via the device flow.',
        });
        return json(
            {
                error: 'invalid_grant',
                error_description: 'Invalid or expired refresh token',
                code:
                    rotateResult.reason === 'revoked'
                        ? ERROR_CODES.REFRESH_TOKEN_REVOKED
                        : rotateResult.reason === 'expired'
                          ? ERROR_CODES.REFRESH_TOKEN_EXPIRED
                          : ERROR_CODES.REFRESH_TOKEN_INVALID,
            },
            { status: 400, headers: TOKEN_RESPONSE_HEADERS },
        );
    }

    const newRefreshToken = rotateResult.token;

    logger.debug('Access token refreshed with rotation', {
        replayed: rotateResult.replayed,
        userId: record.user_id,
        clientId: record.client_id,
    });

    const { config } = await import('$lib/server/config');
    return json(
        {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: config.JWT_ACCESS_TOKEN_TTL_SECONDS,
            refresh_token: newRefreshToken, // Return NEW rotated refresh token
            scope: record.scope || undefined,
        },
        { headers: TOKEN_RESPONSE_HEADERS },
    );
}
