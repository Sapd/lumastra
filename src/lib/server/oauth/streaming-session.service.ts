// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Streaming Session Service
// Manages long-lived tokens for HLS playback that don't expire during movie/live TV viewing
// Tokens are scoped to a single media item and IP address for security

import { createHash } from 'crypto';
import type { Sql } from 'postgres';
import { Database } from '../database/connection.js';
import { Logger } from '../utils/logger';
import { LRUCache } from '../cache/lru-cache';
import { standaloneCacheRegistry } from '../cache/standalone-registry';
import { config } from '../config';
import { isDeviceSessionTombstoned } from './device-session-liveness.js';

const logger = Logger.for('OAuth:StreamingSession');

// Token prefix to distinguish from JWT, PAT, and service tokens
// Exported for consistent usage across files
export const STREAM_TOKEN_PREFIX = 'stream_';

// Special IP value that indicates "any IP allowed" (for AirPlay/Chromecast)
// When a session is created with this IP, IP enforcement is skipped during validation
export const WILDCARD_IP = '*';

// Cache TTL for validated sessions (1 minute)
// Short to pick up ended sessions quickly, but long enough to avoid DB hits on every segment
const SESSION_CACHE_TTL_MS = 60 * 1000;

// Debounce interval for last_used_at updates (1 minute)
// Don't update DB on every single segment request
const LAST_USED_UPDATE_DEBOUNCE_MS = 60 * 1000;

// Helper to get config values (called at runtime, not module load)
function getInactivityTimeoutMs(): number {
    return (config.STREAMING_SESSION_INACTIVITY_MINUTES || 120) * 60 * 1000;
}

/**
 * Hash a token using SHA-256 for secure storage
 */
function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export interface StreamingSessionRecord {
    id: string;
    token_hash: string;
    /** Public id is the existing UUID primary key, never the secret. */
    play_session_id?: string | null;
    grant_kind?: 'video' | 'music' | 'audiobook' | 'live' | 'preview' | null;
    grant_ttl_ms?: number | string | null;
    username: string;
    user_id: string;
    device_session_id: string | null;
    /** Internal media_items.id UUID — null for wildcard sessions */
    media_item_id: string | null;
    is_wildcard: boolean;
    client_ip: string;
    created_at: Date;
    last_used_at: Date;
    expires_at: Date;
    is_active: boolean;
    ended_reason: string | null;
    parent_token_hash: string | null;
    /** Admin capability of the minting principal (16.301.0); false for older rows. */
    minted_by_admin: boolean;
}

export interface ValidatedStreamingSession {
    id: string;
    username: string;
    userId: string;
    deviceSessionId: string | null;
    playbackSessionId?: string | null;
    mediaItemId: string | null;
    isWildcard: boolean;
    clientIp: string;
    createdAt: Date;
    lastUsedAt: Date;
    expiresAt: Date;
    /**
     * The request that minted this token had real admin capability
     * (`principal.isAdmin`, never the owner's flag). Honoured on use only
     * while the owner is still an admin.
     */
    mintedByAdmin: boolean;
}

export interface SessionStatus {
    valid: boolean;
    reason?: 'not_found' | 'expired' | 'inactive' | 'wrong_item' | 'wrong_ip' | 'ended';
    /** Username from the token record — present whenever the token exists in the DB. */
    username?: string;
    itemId?: string;
    expiresAt?: Date;
    lastUsedAt?: Date;
    secondsUntilExpiry?: number;
    secondsUntilInactivity?: number;
}

export interface CleanupResult {
    inactiveEnded: number;
    expiredEnded: number;
    orphanedParentsEnded: number;
    oldDeleted: number;
}

type SessionIdRow = { id: string };
type SessionTokenRow = { token_hash: string };
type SessionListRow = {
    id: string;
    media_item_id: string | null;
    is_wildcard: boolean;
    client_ip: string;
    created_at: Date;
    last_used_at: Date;
    expires_at: Date;
};
type SessionEndRow = {
    id: string;
    username: string;
    media_item_id: string | null;
};

export class StreamingSessionService {
    private readonly db: Database;
    private readonly sql: Sql;

    // LRU cache for validated sessions
    private readonly sessionCache: LRUCache<ValidatedStreamingSession>;

    // Track last update times to debounce DB writes
    private readonly lastUpdateTimes: Map<string, number> = new Map();

    constructor() {
        this.db = new Database();
        this.sql = this.db.getSql();
        this.sessionCache = new LRUCache<ValidatedStreamingSession>({
            maxSize: 1000,
            defaultTTL: SESSION_CACHE_TTL_MS,
            namespace: 'streaming-session',
        });

        // Register cache for admin monitoring
        standaloneCacheRegistry.register({
            name: 'streaming-sessions',
            description: 'api/v1: Validated HLS streaming session tokens',
            category: 'auth',
            cache: this.sessionCache,
        });
    }

    /**
     * Cleanup resources on shutdown
     * Clears validation caches and activity timestamps
     */
    shutdown(): void {
        this.sessionCache.clear();
        this.lastUpdateTimes.clear();
        logger.info('Streaming session service shutdown complete');
    }

    /**
     * Validate a streaming session token
     * Returns session info if valid, null otherwise
     */
    async validate(
        token: string,
        requestedItemId: string,
        clientIp: string,
    ): Promise<ValidatedStreamingSession | null> {
        // Must start with stream_ prefix
        if (!token.startsWith(STREAM_TOKEN_PREFIX)) {
            return null;
        }

        const tokenHash = hashToken(token);
        const now = Date.now();

        // Check cache first
        let cached = this.sessionCache.get(tokenHash);

        if (!cached) {
            // Query database. device_session_revoked: the minting device's
            // session has refresh-token rows but none unrevoked. Covers rows
            // the revoke's sweep missed — minted or refreshed on another
            // replica while the revoke ran, a sweep that failed, a replica
            // that restarted and lost its tombstones. A session with no rows
            // at all is not "revoked": cookie callers store a client-chosen
            // device id here.
            const results = await this.sql<
                (StreamingSessionRecord & { device_session_revoked: boolean })[]
            >`
				SELECT t.*,
					(t.device_session_id IS NOT NULL
						AND EXISTS (SELECT 1 FROM oauth_refresh_tokens r
							WHERE r.device_session_id = t.device_session_id)
						AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r
							WHERE r.device_session_id = t.device_session_id
								AND r.revoked_at IS NULL)
					) AS device_session_revoked
				FROM hls_playback_tokens t
				WHERE t.token_hash = ${tokenHash}
					AND t.is_active = true
			`;

            if (results.length === 0) {
                logger.debug('Streaming session validation failed: not found or inactive');
                return null;
            }

            const record = results[0];

            if (record.device_session_revoked) {
                await this.endSessionByHash(tokenHash, 'client_request');
                logger.debug('Streaming session validation failed: device session revoked');
                return null;
            }

            // Check hard expiry
            if (new Date(record.expires_at).getTime() < now) {
                await this.endSessionByHash(tokenHash, 'expired');
                logger.debug('Streaming session validation failed: expired');
                return null;
            }

            // Check inactivity timeout
            const lastUsedTime = new Date(record.last_used_at).getTime();
            if (now - lastUsedTime > getInactivityTimeoutMs()) {
                await this.endSessionByHash(tokenHash, 'inactivity');
                logger.debug('Streaming session validation failed: inactivity timeout');
                return null;
            }

            cached = {
                id: record.id,
                username: record.username,
                userId: record.user_id,
                deviceSessionId: record.device_session_id,
                playbackSessionId: record.play_session_id ?? null,
                mediaItemId: record.media_item_id,
                isWildcard: record.is_wildcard,
                clientIp: record.client_ip,
                createdAt: new Date(record.created_at),
                lastUsedAt: new Date(record.last_used_at),
                expiresAt: new Date(record.expires_at),
                mintedByAdmin: record.minted_by_admin === true,
            };

            // Cache the session
            this.sessionCache.set(tokenHash, cached);
        }

        // The device that minted this token was logged out / revoked (this
        // replica learned it locally, via the bus, or via the marker). The DB
        // row is ended by the revoking replica; this stops our cached copy now
        // rather than after SESSION_CACHE_TTL_MS.
        if (cached.deviceSessionId && isDeviceSessionTombstoned(cached.deviceSessionId)) {
            this.sessionCache.delete(tokenHash);
            this.lastUpdateTimes.delete(tokenHash);
            logger.debug('Streaming session rejected: device session revoked');
            return null;
        }

        // Validate item ID matches (skip for wildcard sessions)
        if (!cached.isWildcard && cached.mediaItemId !== requestedItemId) {
            logger.warn('Streaming session validation failed: wrong item', {
                sessionItemId: cached.mediaItemId,
                requestedItemId,
                username: cached.username,
            });
            return null;
        }

        // Validate IP matches (configurable - default: enforce)
        // Skip IP check if session was created with wildcard IP (for AirPlay/Chromecast)
        const enforceIp = config.STREAMING_SESSION_ENFORCE_IP !== false;
        const isWildcardIp = cached.clientIp === WILDCARD_IP;
        if (enforceIp && !isWildcardIp && cached.clientIp !== clientIp) {
            logger.warn('Streaming session validation failed: IP mismatch', {
                sessionIp: cached.clientIp,
                requestIp: clientIp,
                username: cached.username,
                itemId: cached.mediaItemId,
            });
            // Don't end session on IP mismatch - might be temporary network change
            // Just reject this request
            return null;
        }

        // Update last_used_at (debounced)
        const lastUpdate = this.lastUpdateTimes.get(tokenHash) || 0;
        if (now - lastUpdate > LAST_USED_UPDATE_DEBOUNCE_MS) {
            this.lastUpdateTimes.set(tokenHash, now);
            // Fire and forget - don't block on this, but log errors
            this.updateLastUsed(tokenHash).catch((err) => {
                logger.warn('Failed to update streaming session last_used_at', {
                    error: String(err),
                    tokenHashPrefix: tokenHash.substring(0, 8),
                });
            });
        }

        return cached;
    }

    /**
     * Get status of a streaming session (for client to check validity)
     * Optionally checks item ID and IP for more specific error reasons
     */
    async getStatus(
        token: string,
        requestedItemId?: string,
        clientIp?: string,
    ): Promise<SessionStatus> {
        if (!token.startsWith(STREAM_TOKEN_PREFIX)) {
            return { valid: false, reason: 'not_found' };
        }

        const tokenHash = hashToken(token);
        const now = Date.now();

        const results = await this.sql<StreamingSessionRecord[]>`
			SELECT * FROM hls_playback_tokens
			WHERE token_hash = ${tokenHash}
		`;

        if (results.length === 0) {
            return { valid: false, reason: 'not_found' };
        }

        const record = results[0];
        const itemId = record.media_item_id;
        const isWildcard = record.is_wildcard;

        // Check if ended
        if (!record.is_active) {
            return {
                valid: false,
                reason: 'ended',
                username: record.username,
                itemId: itemId ?? undefined,
            };
        }

        // Check hard expiry
        const expiresAt = new Date(record.expires_at);
        if (expiresAt.getTime() < now) {
            return {
                valid: false,
                reason: 'expired',
                username: record.username,
                itemId: itemId ?? undefined,
                expiresAt,
            };
        }

        // Check inactivity
        const lastUsedAt = new Date(record.last_used_at);
        const inactivityExpiresAt = lastUsedAt.getTime() + getInactivityTimeoutMs();
        if (now > inactivityExpiresAt) {
            return {
                valid: false,
                reason: 'inactive',
                username: record.username,
                itemId: itemId ?? undefined,
                lastUsedAt,
            };
        }

        // Check item ID mismatch (if provided)
        // Skip for wildcard sessions (grants access to all items of a type)
        if (requestedItemId && !isWildcard && itemId !== requestedItemId) {
            return {
                valid: false,
                reason: 'wrong_item',
                username: record.username,
                itemId: itemId ?? undefined,
            };
        }

        // Check IP mismatch (if provided and enforcement is enabled)
        // Skip IP check if session was created with wildcard IP (for AirPlay/Chromecast)
        const enforceIp = config.STREAMING_SESSION_ENFORCE_IP !== false;
        const isWildcardIp = record.client_ip === WILDCARD_IP;
        if (enforceIp && !isWildcardIp && clientIp && record.client_ip !== clientIp) {
            return {
                valid: false,
                reason: 'wrong_ip',
                username: record.username,
                itemId: itemId ?? undefined,
            };
        }

        return {
            valid: true,
            username: record.username,
            itemId: itemId ?? undefined,
            expiresAt,
            lastUsedAt,
            secondsUntilExpiry: Math.floor((expiresAt.getTime() - now) / 1000),
            secondsUntilInactivity: Math.floor((inactivityExpiresAt - now) / 1000),
        };
    }

    /**
     * End a streaming session (client-initiated)
     */
    async endSession(token: string): Promise<boolean> {
        if (!token.startsWith(STREAM_TOKEN_PREFIX)) {
            return false;
        }

        const tokenHash = hashToken(token);
        this.sessionCache.delete(tokenHash);
        this.lastUpdateTimes.delete(tokenHash);

        return this.endSessionByHash(tokenHash, 'client_request');
    }

    /**
     * List active sessions for a user
     */
    async listForUser(username: string): Promise<
        Array<{
            id: string;
            itemId: string;
            clientIp: string;
            createdAt: Date;
            lastUsedAt: Date;
            expiresAt: Date;
        }>
    > {
        const results = await this.sql<SessionListRow[]>`
			SELECT id, media_item_id, is_wildcard, client_ip, created_at, last_used_at, expires_at
			FROM hls_playback_tokens
			WHERE username = ${username}
				AND is_active = true
			ORDER BY created_at DESC
		`;

        return results.map((r) => ({
            id: r.id,
            itemId: r.is_wildcard ? 'wildcard' : (r.media_item_id ?? 'unknown'),
            clientIp: r.client_ip,
            createdAt: new Date(r.created_at),
            lastUsedAt: new Date(r.last_used_at),
            expiresAt: new Date(r.expires_at),
        }));
    }

    /**
     * End all sessions for a user
     */
    async endAllForUser(username: string): Promise<number> {
        // Get all active sessions to clear from cache
        const sessions = await this.sql<SessionTokenRow[]>`
			SELECT token_hash FROM hls_playback_tokens
			WHERE username = ${username}
				AND is_active = true
		`;

        for (const s of sessions) {
            this.sessionCache.delete(s.token_hash);
            this.lastUpdateTimes.delete(s.token_hash);
        }

        const result = await this.sql<SessionIdRow[]>`
			UPDATE hls_playback_tokens
			SET is_active = false, ended_reason = 'client_request'
			WHERE username = ${username}
				AND is_active = true
			RETURNING id
		`;

        if (result.length > 0) {
            logger.info('All streaming sessions ended for user', {
                username,
                count: result.length,
            });
        }

        return result.length;
    }

    /**
     * End all active sessions that were issued under a given PAT hash.
     * Called during PAT revocation to cascade revocation to stream tokens.
     * Returns the token_hash values of ended sessions so the caller can
     * publish Valkey revocation markers for them.
     */
    async endByParentTokenHash(parentTokenHash: string, sql: Sql = this.sql): Promise<string[]> {
        const result = await sql<SessionTokenRow[]>`
            UPDATE hls_playback_tokens
            SET is_active = false, ended_reason = 'parent_pat_revoked'
            WHERE parent_token_hash = ${parentTokenHash}
                AND is_active = true
            RETURNING token_hash
        `;

        for (const r of result) {
            this.sessionCache.delete(r.token_hash);
            this.lastUpdateTimes.delete(r.token_hash);
        }

        if (result.length > 0) {
            logger.info('Streaming sessions ended via PAT revocation cascade', {
                parentTokenHash: parentTokenHash.substring(0, 8) + '...',
                count: result.length,
            });
        }

        return result.map((r) => r.token_hash);
    }

    /**
     * End every active stream session minted under the given device sessions
     * (device logout / device revoke). Stream tokens record the minting JWT's
     * `device_session_id`, so this ends exactly that device's tokens and never
     * the user's other devices' or browser (NULL device session) tokens.
     *
     * Evicts this replica's validation cache; other replicas drop theirs within
     * {@link SESSION_CACHE_TTL_MS}. Returns the ended token hashes.
     *
     * `ended_reason` is `'client_request'` (the user or an admin asked for the
     * device to be signed out): the `valid_ended_reason` CHECK constraint only
     * admits a fixed list, and a dedicated reason is not worth a migration.
     */
    async endByDeviceSessionIds(
        deviceSessionIds: readonly string[],
        sql: Sql = this.sql,
    ): Promise<string[]> {
        if (deviceSessionIds.length === 0) return [];
        const result = await sql<SessionTokenRow[]>`
            UPDATE hls_playback_tokens
            SET is_active = false, ended_reason = 'client_request'
            WHERE device_session_id = ANY(${deviceSessionIds as string[]})
                AND is_active = true
            RETURNING token_hash
        `;

        for (const r of result) {
            this.sessionCache.delete(r.token_hash);
            this.lastUpdateTimes.delete(r.token_hash);
        }

        if (result.length > 0) {
            logger.info('Streaming sessions ended via device session revocation', {
                deviceSessions: deviceSessionIds.length,
                count: result.length,
            });
        }

        return result.map((r) => r.token_hash);
    }

    /**
     * Cleanup expired and inactive sessions
     */
    async cleanup(): Promise<CleanupResult> {
        const now = new Date();
        const inactivityThreshold = new Date(now.getTime() - getInactivityTimeoutMs());
        const deleteThreshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days

        // Mark inactive sessions as ended
        const inactiveResult = await this.sql<SessionTokenRow[]>`
			UPDATE hls_playback_tokens
			SET is_active = false, ended_reason = 'inactivity'
			WHERE is_active = true
				AND last_used_at < ${inactivityThreshold}
			RETURNING token_hash
		`;

        // Clear from cache
        for (const r of inactiveResult) {
            this.sessionCache.delete(r.token_hash);
            this.lastUpdateTimes.delete(r.token_hash);
        }

        // Mark expired sessions as ended
        const expiredResult = await this.sql<SessionTokenRow[]>`
			UPDATE hls_playback_tokens
			SET is_active = false, ended_reason = 'expired'
			WHERE is_active = true
				AND expires_at < ${now}
			RETURNING token_hash
		`;

        // Clear from cache
        for (const r of expiredResult) {
            this.sessionCache.delete(r.token_hash);
            this.lastUpdateTimes.delete(r.token_hash);
        }

        // End stream sessions whose parent PAT has been revoked (orphan sweep).
        // Catches cases where cascadeRevokeStreamSessions in pat.service.ts
        // was interrupted mid-cascade (e.g. transient Valkey flakiness).
        const orphanedResult = await this.sql<SessionTokenRow[]>`
            UPDATE hls_playback_tokens
            SET is_active = false, ended_reason = 'parent_pat_revoked_sweep'
            WHERE parent_token_hash IS NOT NULL
                AND is_active = true
                AND parent_token_hash IN (
                    SELECT token_hash FROM personal_access_tokens
                    WHERE revoked_at IS NOT NULL
                )
            RETURNING token_hash
        `;

        // Clear orphaned sessions from cache
        for (const r of orphanedResult) {
            this.sessionCache.delete(r.token_hash);
            this.lastUpdateTimes.delete(r.token_hash);
        }

        // Delete old ended sessions (keep 7 days for debugging)
        const deleteResult = await this.sql<SessionIdRow[]>`
			DELETE FROM hls_playback_tokens
			WHERE is_active = false
				AND created_at < ${deleteThreshold}
			RETURNING id
		`;

        if (orphanedResult.length > 0) {
            logger.info('Orphaned stream sessions ended by parent PAT sweep', {
                count: orphanedResult.length,
            });
        }

        return {
            inactiveEnded: inactiveResult.length,
            expiredEnded: expiredResult.length,
            orphanedParentsEnded: orphanedResult.length,
            oldDeleted: deleteResult.length,
        };
    }

    /**
     * Check if a token string looks like a streaming session token
     */
    static isStreamToken(token: string): boolean {
        return token.startsWith(STREAM_TOKEN_PREFIX);
    }

    /**
     * Get cache statistics
     */
    getCacheStats() {
        return this.sessionCache.getStats();
    }

    // Private helper methods

    private async updateLastUsed(tokenHash: string): Promise<void> {
        try {
            await this.sql`
				UPDATE hls_playback_tokens
				SET last_used_at = NOW()
				WHERE token_hash = ${tokenHash}
					AND is_active = true
			`;
        } catch (error) {
            logger.warn('Failed to update streaming session last_used_at', {
                error: String(error),
            });
        }
    }

    private async endSessionByHash(tokenHash: string, reason: string): Promise<boolean> {
        const result = await this.sql<SessionEndRow[]>`
			UPDATE hls_playback_tokens
			SET is_active = false, ended_reason = ${reason}
			WHERE token_hash = ${tokenHash}
				AND is_active = true
			RETURNING id, username, media_item_id
		`;

        if (result.length > 0) {
            logger.info('Streaming session ended', {
                sessionId: result[0].id,
                username: result[0].username,
                itemId: result[0].media_item_id,
                reason,
            });
            return true;
        }

        return false;
    }
}

// Singleton instance
let instance: StreamingSessionService | null = null;

export function getStreamingSessionService(): StreamingSessionService {
    if (!instance) {
        instance = new StreamingSessionService();
    }
    return instance;
}
