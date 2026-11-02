// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Refresh Token Service for OAuth 2.0 Device Authorization Grant
// Manages refresh tokens for long-lived sessions

import { randomBytes, createHash } from 'crypto';
import type { UserId } from '$lib/shared/user-id';
import type postgres from 'postgres';
import { Database } from '../database/connection.js';
import { config } from '../config';
import { Logger } from '../utils/logger';
import {
    getDeviceApprover,
    hasConflictingDeviceSessionLineage,
    validateRefreshToken,
    getActiveRefreshTokens,
    createRefreshToken,
    updateRefreshTokenLastUsed,
    lockDeviceSessions,
    isDeviceSessionRevokedInDb,
    updateRefreshTokenGroups,
    cleanupRefreshTokens,
} from '../database/queries/oauth-refresh-tokens.queries.js';
import { withTx } from '../database/with-tx.js';
import { cacheGet, setEx } from '../cache/valkey.js';
import {
    revokeAllDeviceSessionsForUser,
    revokeDeviceSession,
    revokeDeviceSessionsForUserClient,
} from './device-session-revocation.js';

import { DeviceSessionRevokedError } from './device-session-errors.js';
export { DeviceSessionRevokedError } from './device-session-errors.js';

/**
 * How long a rotation's result stays replayable, in seconds.
 *
 * Sized for "the client retried because it never saw the response", not for
 * "the app was suspended overnight" — the latter is handled durably by the
 * supersede model in {@link RefreshTokenService.rotate}, which has no timer at
 * all. This cache exists purely so a retry inside the window gets back the
 * IDENTICAL refresh token rather than a second, equally-valid one, which is
 * what a client needs in order to never have to guess which token is current.
 */
const REPLAY_CACHE_TTL_SECONDS = 90;

/**
 * Replay-cache key for a rotation keyed by the hash of the token that was
 * presented. Holds the PLAINTEXT of the refresh token that rotation issued.
 *
 * Storing a live secret in Valkey is a deliberate, bounded trade: the database
 * deliberately keeps only SHA-256 hashes so that a dump yields no usable
 * tokens, and that property is unchanged here. A replay that returns the
 * identical token is impossible without retaining the plaintext somewhere,
 * since it cannot be recovered from the hash — so it is kept off-disk, in the
 * same trust domain as the database, for 90 seconds. If Valkey is unavailable
 * the cache silently misses and rotation falls back to issuing a fresh token,
 * which is still valid; nothing breaks, the retry just gets a different token.
 */
function replayCacheKey(tokenHash: string): string {
    return `oauth:refresh:replay:v1:${tokenHash}`;
}

/**
 * Hash a token using SHA-256 for secure storage
 * Tokens are never stored in plaintext - only their hashes
 */
function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

const logger = Logger.for('OAuth:RefreshToken');

export interface RefreshTokenRecord {
    id: number;
    token_hash: string;
    user_id: string;
    client_id: string;
    scope: string | null;
    device_name: string | null;
    user_groups: string[] | null;
    provider_user_id: string | null;
    created_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
    last_used_at: Date | null;
    /** Unique session ID for this device - persists across token refreshes */
    device_session_id: string | null;
    approved_by_device_session_id: string | null;
}

/**
 * Discriminated result from {@link RefreshTokenService.rotate}.
 *
 * None of the failure reasons is a security event on its own, and none of them
 * may revoke the device_session_id family — see the note on {@link
 * RefreshTokenService.rotate} for why the family revocation that used to hang
 * off `'revoked'` was removed.
 */
export type RotateResult =
    | { ok: true; token: string; replayed: boolean }
    | { ok: false; reason: 'not_found' | 'expired' | 'revoked' };

export interface CreateRefreshTokenParams {
    userId: UserId;
    clientId: string;
    scope?: string;
    deviceName?: string;
    groups: string[];
    /** Unique session ID for this device - generated during device authorization */
    deviceSessionId: string;
    /**
     * Client-generated device id. Persisted so the session resolves to its
     * `user_devices` row without going through the Jellyfin provider table.
     */
    deviceId?: string | null;
    approvedByDeviceSessionId?: string | null;
}

export class RefreshTokenService {
    private readonly db: Database;
    private readonly sql: postgres.Sql;

    constructor() {
        this.db = new Database();
        this.sql = this.db.getSql();
    }

    /**
     * Create a new refresh token
     * The token is hashed before storage - only the hash is stored in the database
     * The plaintext token is returned to the client (this is the only time it exists)
     */
    async create(params: CreateRefreshTokenParams, sql: postgres.Sql = this.sql): Promise<string> {
        // Generate cryptographically secure token (64 chars hex)
        const token = randomBytes(32).toString('hex');

        // Hash the token for storage - never store plaintext
        const tokenHash = hashToken(token);

        const expiresAt = new Date(
            Date.now() + config.JWT_REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
        );

        // Under the session lock, so a concurrent revoke of a reused session
        // either sees this row or runs first and makes us refuse.
        await withTx(sql, async (tx: postgres.Sql) => {
            let approverName: string | null = null;
            if (params.approvedByDeviceSessionId) {
                await lockDeviceSessions(tx, [params.approvedByDeviceSessionId]);
                const approver = await getDeviceApprover(
                    tx,
                    params.userId,
                    params.approvedByDeviceSessionId,
                );
                if (
                    !approver ||
                    params.deviceSessionId === params.approvedByDeviceSessionId ||
                    params.clientId === approver.client_id ||
                    (params.deviceId && params.deviceId === approver.device_id)
                )
                    throw new DeviceSessionRevokedError();
                approverName = (approver.device_name || approver.client_id).slice(0, 64);
            }
            await lockDeviceSessions(tx, [params.deviceSessionId]);
            if (
                (await isDeviceSessionRevokedInDb(tx, params.deviceSessionId)) ||
                (await hasConflictingDeviceSessionLineage(
                    tx,
                    params.deviceSessionId,
                    params.approvedByDeviceSessionId ?? null,
                ))
            ) {
                throw new DeviceSessionRevokedError();
            }
            await createRefreshToken(tx, {
                tokenHash,
                userId: params.userId,
                clientId: params.clientId,
                scope: params.scope || null,
                deviceName: params.deviceName || null,
                groups: params.groups,
                jellyfinUserId: null, // No longer written — Jellyfin ID resolved lazily at point of use
                expiresAt,
                deviceSessionId: params.deviceSessionId,
                deviceId: params.deviceId ?? null,
                approvedByDeviceSessionId: params.approvedByDeviceSessionId,
                approvedByDeviceName: approverName,
            });
        });

        logger.info('Refresh token created', {
            userId: params.userId,
            clientId: params.clientId,
            deviceName: params.deviceName,
            deviceSessionId: params.deviceSessionId.substring(0, 8) + '...',
            expiresIn: `${config.JWT_REFRESH_TOKEN_TTL_DAYS} days`,
        });

        // Return the plaintext token to the client
        // This is the only time the plaintext exists - we only store the hash
        return token;
    }

    /**
     * Validate and retrieve a refresh token
     * Returns null if token is invalid, expired, or revoked
     * The incoming plaintext token is hashed and compared against stored hashes
     */
    async validate(token: string): Promise<RefreshTokenRecord | null> {
        // Hash the incoming token to compare against stored hash
        const tokenHash = hashToken(token);

        const record = await validateRefreshToken(this.sql, tokenHash);

        if (!record) {
            return null;
        }

        // Update last_used_at
        await updateRefreshTokenLastUsed(this.sql, tokenHash);

        return record as RefreshTokenRecord;
    }

    /**
     * Revoke all refresh tokens for a user
     */
    async revokeAllForUser(userId: UserId, sql: postgres.Sql = this.sql): Promise<number> {
        // Also cuts off the sessions' access JWTs and stream tokens.
        const { count } = await revokeAllDeviceSessionsForUser(sql, userId);

        if (count > 0) {
            logger.info('All refresh tokens revoked for user', {
                userId,
                count,
            });
        }

        return count;
    }

    /**
     * Revoke all refresh tokens for a user on a specific client
     */
    async revokeForUserClient(userId: UserId, clientId: string): Promise<number> {
        return (await revokeDeviceSessionsForUserClient(this.sql, userId, clientId)).count;
    }

    /**
     * Revoke all active tokens in a device_session_id family.
     *
     * Called on refresh-token reuse detection (RFC 6819 §5.2.2.3): when a
     * rotated token is presented again, the entire session is revoked to limit
     * the blast radius of a stolen token — both the attacker's and the
     * legitimate client's copies become invalid.
     */
    async revokeByDeviceSessionId(deviceSessionId: string): Promise<number> {
        // The caller holds this session's own token, so the cut-off always runs
        // (idempotent; a retry still ends stream tokens).
        const { revokedCount: count } = await revokeDeviceSession(this.sql, deviceSessionId);
        if (count > 0) {
            logger.warn('Device session revoked (refresh-token reuse detected)', {
                deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                revokedCount: count,
            });
        }
        return count;
    }

    /**
     * Rotate a refresh token: issue a replacement and supersede — but do NOT
     * revoke — the token that was presented.
     *
     * The device_session_id is preserved across rotations for consistent device
     * identification.
     *
     * ## Why the presented token survives
     *
     * Revoking it here is only safe if the replacement reliably reaches the
     * client, and it does not: an iOS app suspended mid-request loses the
     * response and wakes holding a token the server already consumed. With no
     * grace of any kind that was a permanent sign-out caused by a dropped HTTP
     * response — observed in prod on device session 1f94de0f, where a token
     * minted by rotation at 23:01 was never used and the phone had to re-login
     * from scratch the next morning.
     *
     * So rotation marks the old token `superseded_at`/`superseded_by` and leaves
     * it valid. It is revoked one rotation later, when its OWN successor is used
     * — the moment the client proves the replacement arrived. The window closes
     * on evidence rather than on a timer, so it covers an arbitrarily long
     * suspend without ever extending a stolen token's life on a fixed schedule.
     *
     * ## Two layers, deliberately
     *
     * 1. Replay cache (Valkey, {@link REPLAY_CACHE_TTL_SECONDS}) — a retry
     *    inside the window gets back the IDENTICAL token, so a client is never
     *    left holding two equally-valid tokens wondering which is current.
     * 2. Supersede (above) — durable, unbounded in time, and the reason a cache
     *    miss or a Valkey outage degrades to "you get a different valid token"
     *    instead of "you are signed out".
     *
     * A short timer alone cannot do this job: the failure actually seen in prod
     * had a nine-hour gap between the lost response and the client's next
     * attempt.
     *
     * ## No family revocation
     *
     * The `'revoked'` reason below used to make the caller revoke the whole
     * device_session_id family as RFC 6819 §5.2.2.3 reuse detection. That was
     * backwards: `validate()` filters `revoked_at IS NULL` before rotate() is
     * ever called, so a genuinely replayed old token was already rejected
     * upstream and never reached this branch — the ONLY way to land here was two
     * concurrent refreshes racing on the same token, i.e. a legitimate client,
     * which then had its session destroyed. The protection was inert against
     * theft and lethal to real users. Under the supersede model both racers now
     * succeed against the still-valid predecessor, so the race has no victim and
     * nothing to punish. Do not reintroduce family revocation here without first
     * moving detection ahead of `validate()`, where it could actually see the
     * delayed replay it is meant to catch.
     *
     * Returns a {@link RotateResult}:
     * - `{ ok: true, token, replayed }` — success; `token` is the plaintext refresh
     *   token, and `replayed` marks it as served from the replay cache.
     * - `{ ok: false, reason: 'revoked' }` — the row was genuinely revoked (logout,
     *   admin action, or superseded a rotation ago) → `invalid_grant`.
     * - `{ ok: false, reason: 'expired' }` — row exists but expired between validate()
     *   and rotate() (TOCTOU race) → `invalid_grant`.
     * - `{ ok: false, reason: 'not_found' }` — hash not in DB at all (cleaned up or
     *   unknown) → `invalid_grant`.
     */
    async rotate(oldToken: string): Promise<RotateResult> {
        const oldTokenHash = hashToken(oldToken);

        // Layer 1: a retry that lost its response gets the identical token back.
        const replayed = await cacheGet(replayCacheKey(oldTokenHash));
        if (replayed && (await validateRefreshToken(this.sql, oldTokenHash))) {
            logger.info('Refresh token rotation replayed from cache', {
                hint: 'client retried a rotation whose response it never received',
            });
            return { ok: true, token: replayed, replayed: true };
        }

        const result = await withTx(this.sql, async (tx: postgres.Sql) => {
            // Serialize against device-session revocation FIRST (see
            // lockDeviceSessions): a revoke that commits before we get the lock
            // has revoked the presented row, so the locked SELECT below finds
            // nothing and the rotation is refused; a revoke that waits for us
            // runs after commit and sees the successor we insert.
            const sessionOfToken = await tx<{ device_session_id: string | null }[]>`
                SELECT device_session_id FROM oauth_refresh_tokens
                WHERE token_hash = ${oldTokenHash}
            `;
            if (sessionOfToken[0]?.device_session_id) {
                await lockDeviceSessions(tx, [sessionOfToken[0].device_session_id]);
            }

            // Lock the row to serialize concurrent rotation attempts on the same token.
            const rows = await tx<
                {
                    id: number;
                    user_id: string;
                    client_id: string;
                    scope: string | null;
                    device_name: string | null;
                    user_groups: string[] | null;
                    device_session_id: string | null;
                    device_id: string | null;
                    approved_by_device_session_id: string | null;
                    approved_by_device_name: string | null;
                }[]
            >`
                SELECT id, user_id, client_id, scope, device_name, user_groups, device_session_id,
                       device_id, approved_by_device_session_id, approved_by_device_name
                FROM oauth_refresh_tokens
                WHERE token_hash = ${oldTokenHash}
                  AND revoked_at IS NULL
                  AND expires_at > NOW()
                FOR UPDATE
            `;

            if (!rows.length) {
                // Distinguish the failure reason so the caller can avoid a false
                // reuse-detection when the token merely expired between validate() and
                // rotate() (TOCTOU window).
                const stateRows = await tx<{ revoked_at: Date | null; expires_at: Date }[]>`
                    SELECT revoked_at, expires_at
                    FROM oauth_refresh_tokens
                    WHERE token_hash = ${oldTokenHash}
                    FOR UPDATE
                `;
                if (!stateRows.length) {
                    logger.warn('Token rotation failed: token not found');
                    return { ok: false, reason: 'not_found' } satisfies RotateResult;
                }
                const state = stateRows[0];
                if (state.revoked_at !== null) {
                    // NOT treated as reuse detection, and deliberately not a family
                    // revocation — see the "No family revocation" note above.
                    logger.warn('Token rotation failed: token revoked');
                    return { ok: false, reason: 'revoked' } satisfies RotateResult;
                }
                // revoked_at IS NULL but expires_at <= NOW() — expired in the TOCTOU window
                logger.warn('Token rotation failed: token expired between validate and rotate', {
                    expiredAt: state.expires_at,
                });
                return { ok: false, reason: 'expired' } satisfies RotateResult;
            }

            const record = rows[0];

            // Generate and insert the new token
            const newPlainToken = randomBytes(32).toString('hex');
            const newTokenHash = hashToken(newPlainToken);
            const expiresAt = new Date(
                Date.now() + config.JWT_REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
            );

            const insertedRows = await tx<{ id: number }[]>`
                INSERT INTO oauth_refresh_tokens (
                    token_hash, user_id, client_id, scope, device_name,
                    user_groups, provider_user_id, expires_at, device_session_id,
                    device_id, approved_by_device_session_id, approved_by_device_name
                ) VALUES (
                    ${newTokenHash},
                    ${record.user_id},
                    ${record.client_id},
                    ${record.scope},
                    ${record.device_name},
                    ${record.user_groups},
                    ${null},
                    ${expiresAt},
                    ${record.device_session_id},
                    ${record.device_id}, ${record.approved_by_device_session_id}::uuid, ${record.approved_by_device_name}
                )
                RETURNING id
            `;
            const newId = insertedRows[0].id;

            // Supersede — NOT revoke — the presented token. It stays valid so a
            // client that never receives this response can still refresh with what
            // it holds. Note this leaves `revoked_at` untouched, so migration
            // 16.200.0's push-deactivation trigger (which fires only on
            // revoked_at NULL -> NOT NULL) does not run for a rotation at all now.
            await tx`
                UPDATE oauth_refresh_tokens
                SET superseded_at = NOW(), superseded_by = ${newId}
                WHERE id = ${record.id}
            `;

            // The presented token demonstrably reached the client, so every token
            // it already moved on from is finally safe to kill. This is the ONLY
            // place a rotation revokes anything, and it is always at least one
            // rotation behind the client.
            //
            // Scoped to "superseded, in this session, other than the one just
            // presented" rather than to `superseded_by = record.id`: two concurrent
            // rotations of the same token both succeed (each is valid — see the
            // class note), and the second overwrites the first's `superseded_by`,
            // so following that single link would strand the original token as
            // valid-but-unreachable for its full 90-day life. Tokens the client
            // demonstrably has NOT moved on from — the unused sibling minted by a
            // concurrent rotation — are never superseded, so they are never caught
            // here. They simply expire.
            //
            // The push trigger DOES fire here. It is a deferred constraint trigger,
            // so at COMMIT its `NOT EXISTS` check sees both the row inserted above
            // and the still-unrevoked presented token as live sessions for the
            // device — push survives rotation for the same reason it did before.
            if (record.device_session_id) {
                await tx`
                    UPDATE oauth_refresh_tokens
                    SET revoked_at = NOW()
                    WHERE device_session_id = ${record.device_session_id}
                      AND superseded_at IS NOT NULL
                      AND id <> ${record.id}
                      AND revoked_at IS NULL
                `;
            } else {
                // Legacy rows predate device sessions; fall back to the direct link.
                await tx`
                    UPDATE oauth_refresh_tokens
                    SET revoked_at = NOW()
                    WHERE superseded_by = ${record.id}
                      AND revoked_at IS NULL
                `;
            }

            logger.debug('Refresh token rotated', {
                userId: record.user_id,
                clientId: record.client_id,
                deviceSessionId: record.device_session_id?.substring(0, 8) + '...',
                supersededTokenId: record.id,
            });

            return { ok: true, token: newPlainToken, replayed: false } satisfies RotateResult;
        });

        // Publish for replay only after the transaction committed, so a retry can
        // never be handed a token that rolled back. A failed write here is
        // survivable: the retry misses the cache and rotates again against the
        // still-valid superseded token, getting a different — but equally valid —
        // token instead of an error.
        if (result.ok) {
            await setEx(replayCacheKey(oldTokenHash), REPLAY_CACHE_TTL_SECONDS, result.token);
        }

        return result;
    }

    /**
     * Get all active tokens for a user
     * Useful for displaying active sessions in settings
     */
    async getActiveTokensForUser(userId: UserId): Promise<RefreshTokenRecord[]> {
        return (await getActiveRefreshTokens(this.sql, userId)) as RefreshTokenRecord[];
    }

    /**
     * Update the groups stored in a refresh token
     * Called when user's groups change
     */
    async updateGroups(userId: UserId, groups: string[]): Promise<number> {
        return await updateRefreshTokenGroups(this.sql, userId, groups);
    }

    /**
     * Cleanup expired and old revoked tokens (run periodically)
     */
    async cleanup(): Promise<number> {
        const count = await cleanupRefreshTokens(this.sql);

        if (count > 0) {
            logger.info('Cleaned up old refresh tokens', {
                count,
            });
        }

        return count;
    }
}

// Singleton instance
let instance: RefreshTokenService | null = null;

export function getRefreshTokenService(): RefreshTokenService {
    if (!instance) {
        instance = new RefreshTokenService();
    }
    return instance;
}
