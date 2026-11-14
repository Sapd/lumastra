// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native-login session service.
 *
 * Server-side session store for built-in (username/password) browser login,
 * modeled on oauth/refresh-token.service.ts: an opaque token is handed to the
 * client (in an HttpOnly cookie) and only its SHA-256 hash is persisted, so a DB
 * leak never yields a usable session. Sessions are stored in Postgres and thus
 * shared across replicas — no sticky sessions.
 *
 * AGPL-core. Independent of the `/j` jellyfin_client_passwords store.
 */

import { randomBytes, createHash } from 'node:crypto';
import type postgres from 'postgres';
import { Database } from '../database/connection.js';
import { config } from '../config.js';
import { Logger } from '../utils/logger.js';
import {
    createSession as createSessionQuery,
    findValidSessionWithUser,
    touchSession,
    revokeSession as revokeSessionQuery,
    revokeAllUserSessions,
    revokeAllUserSessionsExcept,
    revokeUserSessionByIdScoped,
    cleanupExpiredSessions,
    revokeSessionsByOidcSid,
    revokeSessionsByOidcSub,
    type ValidatedSessionRow,
} from '../database/queries/user-sessions.queries.js';

const logger = Logger.for('NativeSession');

/** Opaque session-token prefix (purely for log/debug recognizability). */
const SESSION_TOKEN_PREFIX = 'lsess_';

/** SHA-256 hex of the opaque token — what we actually store and look up by. */
function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * Defensive bound: a stored token is 6 (prefix) + 64 (hex) = 70 chars. Reject
 * anything wildly longer before hashing so a hostile cookie can't drive DoS.
 */
const MAX_SESSION_TOKEN_LENGTH = 256;

// Per-process throttle for last_used_at writes so validation doesn't issue a
// write on every request. Multi-replica: each process throttles independently,
// which is fine for a best-effort liveness timestamp.
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;
const lastTouched = new Map<string, number>();

// Evict stale throttle entries so the map can't grow unbounded with the number
// of distinct sessions ever seen by this process (mirrors the cleanup on the
// jwtStreamWarningTimes / groupSyncL1Cache maps).
setInterval(
    () => {
        const now = Date.now();
        for (const [sessionId, ts] of lastTouched.entries()) {
            if (now - ts > TOUCH_THROTTLE_MS * 2) lastTouched.delete(sessionId);
        }
    },
    10 * 60 * 1000,
).unref?.();

export interface CreateSessionParams {
    userId: string;
    userAgent?: string | null;
    ip?: string | null;
    /** Link to the originating OP session for OIDC Back-Channel Logout. */
    oidc?: { iss: string; sub: string; sid?: string | null };
}

export class SessionService {
    private readonly sql: postgres.Sql;

    constructor() {
        this.sql = new Database().getSql();
    }

    private ttlMs(): number {
        // Clamp to a sane window even if misconfigured.
        const days = Math.min(365, Math.max(1, config.NATIVE_AUTH_SESSION_TTL_DAYS));
        return days * 24 * 60 * 60 * 1000;
    }

    /**
     * Create a new session for a user. Returns the plaintext opaque token (the
     * ONLY time it exists) to set in the cookie.
     */
    async create(
        params: CreateSessionParams,
        sql: postgres.Sql = this.sql,
    ): Promise<{ token: string; expiresAt: Date }> {
        const token = SESSION_TOKEN_PREFIX + randomBytes(32).toString('hex');
        const tokenHash = hashToken(token);
        const expiresAt = new Date(Date.now() + this.ttlMs());

        await createSessionQuery(sql, {
            userId: params.userId,
            tokenHash,
            expiresAt,
            userAgent: params.userAgent ?? null,
            ip: params.ip ?? null,
            oidcIss: params.oidc?.iss ?? null,
            oidcSub: params.oidc?.sub ?? null,
            oidcSid: params.oidc?.sid ?? null,
        });

        logger.info('Native session created', {
            userId: params.userId,
            expiresAt: expiresAt.toISOString(),
        });

        return { token, expiresAt };
    }

    /**
     * Validate a session token. Returns the joined session+user row, or null if
     * the token is malformed, unknown, revoked, or expired. Updates last_used_at
     * at most once per TOUCH_THROTTLE_MS per process (best effort).
     */
    async validate(token: string): Promise<ValidatedSessionRow | null> {
        if (!token || token.length > MAX_SESSION_TOKEN_LENGTH) return null;
        if (!token.startsWith(SESSION_TOKEN_PREFIX)) return null;

        const tokenHash = hashToken(token);
        const row = await findValidSessionWithUser(this.sql, tokenHash);
        if (!row) return null;

        const now = Date.now();
        const last = lastTouched.get(row.session_id) ?? 0;
        if (now - last > TOUCH_THROTTLE_MS) {
            lastTouched.set(row.session_id, now);
            // Fire-and-forget; never block or fail auth on a liveness write.
            void touchSession(this.sql, tokenHash).catch(() => {});
        }

        return row;
    }

    /** Revoke a single session by its plaintext token (logout). */
    async revoke(token: string): Promise<boolean> {
        if (!token || token.length > MAX_SESSION_TOKEN_LENGTH) return false;
        const tokenHash = hashToken(token);
        const count = await revokeSessionQuery(this.sql, tokenHash);
        return count > 0;
    }

    /** Revoke a logout retry receipt; a token hash never authenticates a request. */
    async revokeByTokenHash(tokenHash: string): Promise<boolean> {
        if (!/^[a-f0-9]{64}$/.test(tokenHash)) return false;
        return (await revokeSessionQuery(this.sql, tokenHash)) > 0;
    }

    /** Revoke ALL of a user's sessions (logout-everywhere). */
    async revokeAllForUser(userId: string, sql: postgres.Sql = this.sql): Promise<number> {
        const count = await revokeAllUserSessions(sql, userId);
        if (count > 0) {
            logger.info('All native sessions revoked for user', { userId, count });
        }
        return count;
    }

    /**
     * Revoke all of a user's sessions EXCEPT the one for `keepToken` (the
     * just-issued current-device session). Used on password change so the user
     * stays logged in here but is logged out everywhere else — with no instant
     * where zero live sessions exist.
     */
    async revokeAllForUserExcept(
        userId: string,
        keepToken: string,
        sql: postgres.Sql = this.sql,
    ): Promise<number> {
        const count = await revokeAllUserSessionsExcept(sql, userId, hashToken(keepToken));
        if (count > 0) {
            logger.info('Other native sessions revoked for user', { userId, count });
        }
        return count;
    }

    /** Revoke one of the user's own native sessions by row id (IDOR-safe). */
    async revokeOwnSessionById(id: string, userId: string): Promise<boolean> {
        const count = await revokeUserSessionByIdScoped(this.sql, id, userId);
        if (count > 0) {
            logger.info('Native session revoked by owner', { userId, id });
        }
        return count > 0;
    }

    /** Back-Channel Logout: revoke the session(s) for one OP session (iss, sid). */
    async revokeByOidcSession(params: { iss: string; sid: string }): Promise<number> {
        const count = await revokeSessionsByOidcSid(this.sql, params.iss, params.sid);
        if (count > 0) {
            logger.info('OIDC back-channel logout revoked session(s) by sid', {
                iss: params.iss,
                count,
            });
        }
        return count;
    }

    /** Back-Channel Logout: revoke all sessions for the End-User (iss, sub). */
    async revokeByOidcSubject(params: {
        iss: string;
        sub: string;
    }): Promise<{ count: number; userIds: string[] }> {
        const userIds = await revokeSessionsByOidcSub(this.sql, params.iss, params.sub);
        if (userIds.length > 0) {
            logger.info('OIDC back-channel logout revoked sessions by sub', {
                iss: params.iss,
                users: userIds.length,
            });
        }
        // count of distinct users is enough for logging; the cascade only needs ids.
        return { count: userIds.length, userIds };
    }

    /** Delete expired and long-revoked sessions (periodic GC). */
    async cleanup(): Promise<number> {
        const count = await cleanupExpiredSessions(this.sql);
        if (count > 0) logger.info('Cleaned up expired native sessions', { count });
        return count;
    }
}

let instance: SessionService | null = null;

export function getSessionService(): SessionService {
    if (!instance) instance = new SessionService();
    return instance;
}
