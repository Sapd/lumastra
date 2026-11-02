// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    AuthDependencyUnavailableError,
    isDependencyError,
} from '$lib/server/auth/dependency-unavailable.js';

import type { PublicAuthor } from '$lib/schemas/public-author.js';
import { userImageSets } from '$lib/server/services/image-descriptor/avatars.js';
import { toPublicAuthor } from '$lib/server/utils/public-author.js';
// Personal Access Token (PAT) Service
// Manages user-created API tokens for dashboards and external integrations

import { randomBytes, createHash } from 'crypto';
import type postgres from 'postgres';
import type { Sql } from 'postgres';
import { withTx } from '../database/with-tx.js';
import { Database } from '../database/connection.js';
import { Logger } from '../utils/logger';
import { LRUCache } from '../cache/lru-cache';
import { standaloneCacheRegistry } from '../cache/standalone-registry';
import { PatUsageBatcher } from './pat-usage-batcher.js';
import { recordPatUsage } from '../database/queries/pat-usage.queries.js';
import { cacheTtlUntilExpiry } from './token-cache-ttl.js';
import { warnRevocationMarkerUnavailable } from './revocation-marker-warning.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { isAdminClassScope } from '$lib/server/api/principal.js';
import {
    publishAuthCacheInvalidation,
    onRemoteTokenNarrowedInvalidate,
    onAuthCacheBusResync,
} from '$lib/server/cache/auth-cache-bus.js';
import { isLifecycleActive } from '$lib/server/auth/user-lifecycle.js';

const logger = Logger.for('OAuth:PAT');

// Token prefix to distinguish from JWT and service tokens
const PAT_PREFIX = 'pat_';

// Cache TTL for validated tokens (30 minutes)
// Revocations are propagated cluster-wide via the pat-revoked: Valkey key (TTL = this value),
// so the only gap is if Valkey is down. DB hits avoided for the full window.
const TOKEN_CACHE_TTL_MS = 30 * 60 * 1000;

// Maximum active PATs per user
const MAX_PATS_PER_USER = 10;

// Valkey key prefix for cluster-wide PAT revocation broadcasts.
// On revoke we write `${PAT_REVOCATION_KEY_PREFIX}${token_hash}` with TTL = cache TTL.
// Other replicas re-check this on every cache hit and evict their LRU.
const PAT_REVOCATION_KEY_PREFIX = 'pat-revoked:';

// Negative cache for cross-replica revocation checks. When a Valkey GET shows
// the token is NOT revoked, remember that result briefly so we skip Valkey on
// repeat requests inside the window. Worst case: a token revoked on replica A
// is still accepted on replica B for up to this TTL after the broadcast lands.
// 5s is shorter than the existing PAT cache TTL contract (5 min) and matches
// how quickly a logged-out user expects revocation to actually take effect.
const REVOCATION_NEGATIVE_CACHE_TTL_MS = 5_000;
const REVOCATION_NEGATIVE_CACHE_MAX = 2_000;

// Valkey key prefix for stream token revocation markers written during PAT cascade.
// Uses the same prefix as streaming-session revocations if one exists, or a dedicated one.
const STREAM_REVOCATION_KEY_PREFIX = 'stream-token-revoked:';

/**
 * Hash a token using SHA-256 for secure storage
 */
function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * Normalize an IP address for comparison.
 * Strips the IPv6-mapped IPv4 prefix `::ffff:` so an allowlist entry of
 * `10.0.0.5` matches a request that arrives as `::ffff:10.0.0.5` from a
 * dual-stack socket.
 */
function normalizeIp(ip: string): string {
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * Check whether a client IP matches any entry in an allowlist.
 * Both sides are normalized (IPv6-mapped IPv4 → IPv4) before comparison.
 */
function isIpAllowed(clientIp: string | undefined, allowed: string[]): boolean {
    if (!clientIp) return false;
    const normalizedClient = normalizeIp(clientIp);
    return allowed.some((entry) => normalizeIp(entry) === normalizedClient);
}

/**
 * Generate a PAT token (pat_ prefix + 48-char random hex)
 */
function generatePatToken(): string {
    return PAT_PREFIX + randomBytes(24).toString('hex');
}

/**
 * Get first 12 characters of token for display (pat_XXXXXXXX)
 */
function getTokenPrefix(token: string): string {
    return token.substring(0, 12);
}

export interface PatRecord {
    id: number;
    token_hash: string;
    token_prefix: string;
    user_id: string;
    name: string;
    description: string | null;
    scopes: string[];
    user_groups: string[] | null;
    jellyfin_user_id: string | null;
    allowed_ips: string[] | null;
    created_at: Date;
    expires_at: Date | null;
    revoked_at: Date | null;
    last_used_at: Date | null;
    last_used_ip: string | null;
    usage_count: number;
    /** Admin-demotion kill-switch — see `markAdminScopedForceNonAdminForUser()`. */
    force_non_admin: boolean;
    /**
     * When `force_non_admin` was set BY OUR OWN demotion-narrowing, `NULL`
     * otherwise. See `markAdminScopedForceNonAdminForUser()` /
     * `clearForceNonAdminForUser()` (migration 16.256.0).
     */
    force_non_admin_narrowed_at: Date | null;
}

export interface ValidatedPat {
    id: number;
    /** Stable users.id UUID (the token owner) — the user-data key. */
    userId: UserId;
    /** Owner's current username (resolved fresh from users; display only). */
    username: string;
    name: string;
    scopes: string[];
    groups: string[];
    jellyfinUserId: string | null;
    tokenPrefix: string;
    allowedIps: string[] | null;
    /**
     * Admin-demotion kill-switch (security review 2026-09-15, C4). Mirrors
     * `service_tokens.force_non_admin` / `ValidatedServiceToken.forceNonAdmin`
     * exactly: `true` means this credential is never admin regardless of its
     * `scopes` or its owner's current admin status —
     * `principal.ts`'s `deriveIsAdmin()` / `buildPrincipal()` already handle
     * this generically for every token kind. `forward-auth.ts`'s `pat`
     * branch and `resolve-bearer-principal.ts`'s `pat_` branch both read this
     * field instead of hardcoding `false`.
     */
    forceNonAdmin: boolean;
}

export interface CreatePatParams {
    userId: UserId;
    name: string;
    description?: string;
    scopes?: string[];
    groups: string[];
    jellyfinUserId?: string; // Optional - may not be available if Jellyfin lookup fails
    allowedIps?: string[]; // Optional IP allowlist; null/empty = any IP allowed
    expiresInDays?: number | null; // null = no expiration
}

export interface PatListItem {
    id: number;
    name: string;
    description: string | null;
    tokenPrefix: string;
    scopes: string[];
    allowedIps: string[] | null;
    createdAt: Date;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    lastUsedIp: string | null;
    usageCount: number;
    isExpired: boolean;
}

export interface AdminPatListItem extends PatListItem {
    owner: PublicAuthor;
}

type PatCountRow = { count: string };
type PatUserStatusRow = {
    username: string;
    groups: string[] | null;
    deleted_at: Date | null;
    disabled_at: Date | null;
};
type PatTokenRow = { token_hash: string; user_id: string };
type PatTokenHashRow = { token_hash: string };
type PatIdRow = { id: number };
type PatListRow = {
    id: number;
    name: string;
    description: string | null;
    token_prefix: string;
    scopes: string[] | null;
    allowed_ips: string[] | null;
    created_at: Date;
    expires_at: Date | null;
    last_used_at: Date | null;
    last_used_ip: string | null;
    usage_count: number;
    user_id?: string;
    /** Resolved from `users.username` (mig join) — null when the owner was deleted. */
    owner_display_name?: string | null;
};

export class PatService {
    private readonly db: Database;
    private readonly sql: Sql;

    // LRU cache to avoid DB lookups on every request
    private readonly tokenCache: LRUCache<ValidatedPat>;
    private readonly usage: PatUsageBatcher;

    // Negative cache for checkValkeyRevocation results.
    // Map<tokenHash, timestamp-of-last-clean-check>. A clean check inside the
    // TTL window short-circuits the Valkey GET. Local revocations explicitly
    // invalidate the corresponding entry.
    private readonly revocationCheckCache: Map<string, number> = new Map();

    constructor() {
        this.db = new Database();
        this.sql = this.db.getSql();
        this.usage = new PatUsageBatcher(
            (batch) => recordPatUsage(this.sql, batch),
            (error) => logger.warn('Failed to flush PAT usage', { error: String(error) }),
        );
        this.tokenCache = new LRUCache<ValidatedPat>({
            maxSize: 500,
            defaultTTL: TOKEN_CACHE_TTL_MS,
            namespace: 'pat',
        });

        // Register cache for admin monitoring
        standaloneCacheRegistry.register({
            name: 'personal-access-tokens',
            description: 'Validated Personal Access Tokens (PATs)',
            category: 'auth',
            cache: this.tokenCache,
        });

        // Cross-replica narrow/un-narrow propagation (security review
        // 2026-09-16, C4 fix round 1 review) — see auth-cache-bus.ts's
        // onRemoteTokenNarrowedInvalidate() doc comment. A no-op delete when
        // the broadcast hash belongs to a service token instead.
        onRemoteTokenNarrowedInvalidate((tokenHash) => this.tokenCache.delete(tokenHash));
        // A narrow event published while the bus was down is lost: re-validate
        // every token after the bus comes back.
        onAuthCacheBusResync(() => this.tokenCache.clear());
    }

    /**
     * Returns true when scopes is exactly ['jellyfin_compat'] OR
     * ['jellyfin_compat_read'].
     * Used to skip the LRU cache so that revocation is immediately visible
     * cluster-wide without waiting for TTL expiry. Both flavors of the
     * jellyfin-compat exclusive scope share the same revocation-visibility
     * requirement (companion-app traffic is low and operators must be able
     * to kill access immediately).
     */
    private static isJellyfinCompatScope(scopes: string[]): boolean {
        if (scopes.length !== 1) return false;
        return scopes[0] === 'jellyfin_compat' || scopes[0] === 'jellyfin_compat_read';
    }

    /**
     * Create a new Personal Access Token
     * Returns the plaintext token (only returned once!)
     */
    async create(params: CreatePatParams): Promise<{ token: string; id: number }> {
        // Validate scopes BEFORE entering the transaction so we don't burn a
        // lock on a request that's going to fail input validation.
        const normalizedScopes = (params.scopes ?? ['read']).map((s) => s.trim().toLowerCase());
        if (normalizedScopes.includes('jellyfin_compat') && normalizedScopes.length !== 1) {
            throw new Error("'jellyfin_compat' is exclusive — must be the only scope");
        }
        if (normalizedScopes.includes('jellyfin_compat_read') && normalizedScopes.length !== 1) {
            throw new Error("'jellyfin_compat_read' is exclusive — must be the only scope");
        }
        const scopes = normalizedScopes;

        // Generate token outside the txn — generation is deterministic-failure-free
        // and we don't want to hold locks longer than necessary.
        const token = generatePatToken();
        const tokenHash = hashToken(token);
        const tokenPrefix = getTokenPrefix(token);

        // Calculate expiration
        let expiresAt: Date | null = null;
        if (params.expiresInDays !== null && params.expiresInDays !== undefined) {
            expiresAt = new Date(Date.now() + params.expiresInDays * 24 * 60 * 60 * 1000);
        }

        // userId is a stable users.id UUID — use it as-is as the lock key.
        const userId = params.userId;

        // Lock key is hash of userId — different users don't contend.
        const lockKey = hashToken(userId).substring(0, 8);
        const lockKeyInt = parseInt(lockKey, 16) % 2147483647; // Fit in PostgreSQL int4

        // The advisory lock MUST live inside a transaction that also holds
        // the count-and-insert. `pg_advisory_xact_lock` releases on COMMIT/
        // ROLLBACK; called against the bare auto-committed connection it
        // released immediately and the cap check raced.
        // postgres.js types TransactionSql and Sql as distinct generics despite
        // being structurally compatible at runtime; cast via unknown to satisfy
        // the call-site template-tag invocations (matches migration-system.ts).
        const createdId = await this.sql.begin(async (txRaw): Promise<number> => {
            const tx = txRaw as unknown as postgres.Sql;
            await tx`SELECT pg_advisory_xact_lock(${lockKeyInt})`;

            const countResult = await tx<PatCountRow[]>`
                SELECT COUNT(*) as count FROM personal_access_tokens
                WHERE user_id = ${userId}
                  AND revoked_at IS NULL
                  AND (expires_at IS NULL OR expires_at > NOW())
            `;
            const currentCount = parseInt(countResult[0]?.count || '0', 10);
            if (currentCount >= MAX_PATS_PER_USER) {
                throw new Error(`Maximum of ${MAX_PATS_PER_USER} active tokens allowed per user`);
            }

            // Normalize empty arrays to null — null means "any IP allowed"
            // and is a cleaner sentinel than an empty array.
            const allowedIps =
                params.allowedIps && params.allowedIps.length > 0 ? params.allowedIps : null;

            const result = await tx<PatIdRow[]>`
                INSERT INTO personal_access_tokens (
                    token_hash, token_prefix, user_id, name, description,
                    scopes, user_groups, jellyfin_user_id, allowed_ips, expires_at
                ) VALUES (
                    ${tokenHash},
                    ${tokenPrefix},
                    ${userId},
                    ${params.name},
                    ${params.description || null},
                    ${scopes},
                    ${params.groups},
                    ${params.jellyfinUserId || null},
                    ${allowedIps},
                    ${expiresAt}
                )
                RETURNING id
            `;
            const id = result[0]?.id;
            if (!id) {
                throw new Error('Failed to create personal access token');
            }
            return id;
        });

        logger.info('PAT created', {
            id: createdId,
            userId,
            name: params.name,
            tokenPrefix,
            scopes,
            expiresAt: expiresAt?.toISOString() || 'never',
        });

        return {
            token,
            id: createdId,
        };
    }

    /**
     * Validate a PAT and return user context
     * Updates last_used_at and usage_count
     */
    async validate(token: string, clientIp?: string): Promise<ValidatedPat | null> {
        // Must start with pat_ prefix
        if (!token.startsWith(PAT_PREFIX)) {
            return null;
        }

        const tokenHash = hashToken(token);

        // Check cache first for token validity (but NOT groups).
        // jellyfin_compat tokens bypass the cache so revocation is immediate cluster-wide.
        // The performance cost is acceptable because companion-app traffic is low.
        const fromCache = this.tokenCache.get(tokenHash);
        let cached =
            fromCache && !PatService.isJellyfinCompatScope(fromCache.scopes)
                ? fromCache
                : undefined;

        if (!cached) {
            // Query database for token validity
            const results = await this.sql<PatRecord[]>`
        SELECT * FROM personal_access_tokens
        WHERE token_hash = ${tokenHash}
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
      `;

            if (results.length === 0) {
                logger.debug('PAT validation failed: token not found or expired');
                return null;
            }

            const record = results[0];
            const recordScopes = record.scopes || ['read'];
            const recordIsJellyfinCompat = PatService.isJellyfinCompatScope(recordScopes);

            // Cache-miss revocation check: another replica may have written a
            // revocation marker AFTER we issued the SELECT but before we cache
            // the row (small window when revoke()'s UPDATE has not yet
            // committed but the broadcast has propagated). Without this, a
            // concurrent revoke could be undone by re-caching the un-revoked
            // record. For jellyfin_compat tokens we bypass the negative cache
            // — the scope contract is "revocation is immediate cluster-wide".
            if (
                (await this.checkValkeyRevocation(tokenHash, recordIsJellyfinCompat)) === 'revoked'
            ) {
                logger.info('PAT rejected: revoked on another replica (cache-miss path)', {
                    tokenPrefix: record.token_prefix,
                });
                return null;
            }

            // Check IP restriction on cache-miss path.
            // SECURITY: If IP allowlist is configured but no clientIp provided, reject.
            if (record.allowed_ips && record.allowed_ips.length > 0) {
                if (!isIpAllowed(clientIp, record.allowed_ips)) {
                    logger.warn('PAT IP not allowed', {
                        tokenPrefix: record.token_prefix,
                        clientIp: clientIp || '(unknown)',
                        reason: !clientIp ? 'no client IP provided' : 'IP not in allowlist',
                    });
                    return null;
                }
            }

            // Build base validated payload (groups + display username are
            // resolved fresh from users by id below — record.user_id is the
            // stable users.id UUID since the 16.46.0 re-key).
            cached = {
                id: record.id,
                userId: toUserId(record.user_id),
                username: '', // resolved fresh from users (by id) on every request
                name: record.name,
                scopes: recordScopes,
                groups: record.user_groups || [], // Will be overwritten with fresh groups
                jellyfinUserId: record.jellyfin_user_id,
                tokenPrefix: record.token_prefix,
                allowedIps: record.allowed_ips,
                forceNonAdmin: record.force_non_admin === true,
            };

            // Cache token validity (but groups will always be refreshed).
            // jellyfin_compat tokens are never cached — skip write so that
            // revocation is visible immediately on the next request.
            if (!recordIsJellyfinCompat) {
                this.tokenCache.set(
                    tokenHash,
                    cached,
                    cacheTtlUntilExpiry(record.expires_at, TOKEN_CACHE_TTL_MS),
                );
            }

            // Record this use; the telemetry buffer throttles writes independently of token validity.
            await this.updateUsage(tokenHash, clientIp);
        } else {
            // Check Valkey-broadcast revocation. Without this, a token revoked
            // on replica A would still validate on replica B for up to 5 min
            // (LRU TTL). PATs carry user auth, so we close that gap.
            const verdict = await this.checkValkeyRevocation(tokenHash);
            if (verdict === 'revoked') {
                this.tokenCache.delete(tokenHash);
                logger.info('PAT rejected: revoked on another replica', {
                    tokenPrefix: cached.tokenPrefix,
                });
                return null;
            }
            // The marker could not be consulted (Valkey down): the LRU entry
            // alone would keep a PAT revoked on another replica working for
            // the rest of the 30-minute LRU TTL, so ask the row itself (one
            // indexed read, no usage write) — admin/users review 2026-10-07,
            // item 2.
            if (verdict === 'unknown' && !(await this.isRowLive(tokenHash))) {
                this.tokenCache.delete(tokenHash);
                logger.info('PAT rejected: revoked or expired (marker unavailable)', {
                    tokenPrefix: cached.tokenPrefix,
                });
                return null;
            }

            // Check IP restriction on cache-hit path.
            // SECURITY: If IP allowlist is configured but no clientIp provided, reject.
            if (cached.allowedIps && cached.allowedIps.length > 0) {
                if (!isIpAllowed(clientIp, cached.allowedIps)) {
                    logger.warn('PAT IP not allowed', {
                        tokenPrefix: cached.tokenPrefix,
                        clientIp: clientIp || '(unknown)',
                        reason: !clientIp ? 'no client IP provided' : 'IP not in allowlist',
                    });
                    return null;
                }
            }

            // Update usage async (fire and forget on cache hit)
            void this.updateUsage(tokenHash, clientIp).catch((err: unknown) => {
                logger.warn(
                    'PAT usage tracking failed (non-critical)',
                    err instanceof Error ? err : undefined,
                );
            });
        }

        // SECURITY: ALWAYS fetch fresh groups and user status from users table.
        // This prevents privilege escalation if user's groups change after PAT creation,
        // and rejects tokens whose owner has been soft-deleted OR disabled (the
        // admin kill-switch — security review 2026-09-13, C2).
        // Groups are fetched on EVERY request, not cached, because group membership
        // is security-critical and must reflect current permissions.
        let currentGroups: string[];
        let currentUsername: string;
        try {
            const userResult = await this.sql<PatUserStatusRow[]>`
        SELECT username, groups, deleted_at, disabled_at
        FROM users
        WHERE id = ${cached.userId}
      `;

            // isLifecycleActive() (review round 2, Important 2) — the SAME
            // predicate forward-auth.ts's / api-auth.ts's service-token
            // impersonation branches and service-token.service.ts's
            // isCreatorActive() apply to their own row fetch. This was a
            // fourth hand-written copy of the same disabled_at/deleted_at
            // check (De Morgan's form of `!isLifecycleActive(...)`).
            if (userResult.length === 0 || !isLifecycleActive(userResult[0])) {
                // User missing, soft-deleted, or disabled — deny regardless of scope
                logger.warn('PAT validation denied: user missing, soft-deleted, or disabled', {
                    userId: cached.userId,
                    tokenPrefix: cached.tokenPrefix,
                    missing: userResult.length === 0,
                    disabled: userResult.length > 0 && userResult[0].disabled_at !== null,
                });
                return null;
            }

            currentGroups = userResult[0].groups ?? [];
            currentUsername = userResult[0].username;
        } catch (error) {
            // SECURITY: fail closed for ALL scopes. Falling back to the
            // user_groups snapshot taken at PAT creation would let a demoted
            // user retain elevated access during a DB outage. The brief
            // unavailability of the PAT is preferable to stale privileges.
            logger.error(
                'PAT validation: user lookup failed; denying token',
                error instanceof Error ? error : new Error(String(error)),
                {
                    scopes: cached.scopes,
                    tokenPrefix: cached.tokenPrefix,
                },
            );
            if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
            return null;
        }

        // Return validated payload with fresh groups + freshly-resolved username
        const validated: ValidatedPat = {
            ...cached,
            groups: currentGroups,
            username: currentUsername,
        };

        logger.debug('PAT validated', {
            username: currentUsername,
            tokenPrefix: cached.tokenPrefix,
            scopes: cached.scopes,
            groups: currentGroups,
        });

        return validated;
    }

    /** Buffer telemetry; every observed use contributes to the next write. */
    private async updateUsage(tokenHash: string, clientIp?: string): Promise<void> {
        try {
            await this.usage.record(tokenHash, clientIp);
        } catch (error) {
            logger.warn('Failed to update PAT usage', { error: String(error) });
        }
    }

    /** Called only after HTTP has drained, before the PostgreSQL pool closes. */
    async flushUsage(): Promise<void> {
        await this.usage.shutdown();
    }

    /**
     * Write a Valkey marker that this PAT token hash has been revoked.
     * Other replicas read the marker on cache-hit and evict their LRU.
     * TTL = LRU TTL: once the LRU entry would have expired anyway, the
     * marker is no longer useful.
     */
    private async publishValkeyRevocation(tokenHash: string): Promise<void> {
        try {
            const { cacheSet, isCoordinationValkeyReady, connectValkey } =
                await import('$lib/server/cache/valkey.js');
            if (!isCoordinationValkeyReady()) await connectValkey();
            await cacheSet(
                PAT_REVOCATION_KEY_PREFIX + tokenHash,
                '1',
                Math.ceil(TOKEN_CACHE_TTL_MS / 1000),
            );
        } catch (err) {
            logger.warn('PAT revocation broadcast failed; relying on per-replica LRU TTL', {
                error: String(err),
            });
        }
    }

    /**
     * Check whether a PAT token hash has been broadcast as revoked from another
     * replica. Returns true if the marker exists (token is revoked).
     *
     * Uses an in-process negative cache (REVOCATION_NEGATIVE_CACHE_TTL_MS) to
     * skip the Valkey GET when the same token was recently confirmed clean.
     * Local revocations evict their own entry via clearRevocationCheckCache().
     *
     * `bypassNegativeCache` MUST be true for tokens whose scope contract
     * promises immediate cross-replica revocation (jellyfin_compat /
     * jellyfin_compat_read). Those tokens are already excluded from the LRU
     * cache for the same reason; the negative cache would re-introduce the
     * up-to-5s delay we deliberately avoid.
     */
    private async checkValkeyRevocation(
        tokenHash: string,
        bypassNegativeCache = false,
    ): Promise<'revoked' | 'clean' | 'unknown'> {
        const now = Date.now();
        if (!bypassNegativeCache) {
            const lastClean = this.revocationCheckCache.get(tokenHash);
            if (lastClean !== undefined && now - lastClean < REVOCATION_NEGATIVE_CACHE_TTL_MS) {
                return 'clean';
            }
            if (lastClean !== undefined) {
                // Expired entry — drop so we don't grow unbounded over time.
                this.revocationCheckCache.delete(tokenHash);
            }
        }

        try {
            const { cacheGetOrThrow, isCoordinationValkeyReady } =
                await import('$lib/server/cache/valkey.js');
            // Not connected, or the GET failed (cacheGetOrThrow throws into the
            // catch below): the marker cannot be consulted. The cache-hit
            // path confirms against the row instead of trusting the LRU;
            // nothing is recorded in the negative cache (only a real "clean"
            // answer is).
            if (!isCoordinationValkeyReady()) return 'unknown';
            const marker = await cacheGetOrThrow(PAT_REVOCATION_KEY_PREFIX + tokenHash);
            if (marker !== null) return 'revoked';

            if (!bypassNegativeCache) {
                // Cache the clean result. Cap the map; oldest entry first
                // (insertion order) so this is FIFO eviction — adequate for a
                // 5-second TTL where churn dominates.
                if (this.revocationCheckCache.size >= REVOCATION_NEGATIVE_CACHE_MAX) {
                    const oldest = this.revocationCheckCache.keys().next().value;
                    if (oldest !== undefined) this.revocationCheckCache.delete(oldest);
                }
                this.revocationCheckCache.set(tokenHash, now);
            }
            return 'clean';
        } catch (err) {
            warnRevocationMarkerUnavailable(err);
            return 'unknown';
        }
    }

    /**
     * Whether the row behind a cached PAT is still unrevoked and unexpired.
     * Consulted only when the cross-replica marker is unavailable. A DB error
     * rejects (fail closed), like the owner lookup that follows it, which
     * already denies every scope on a DB error.
     */
    private async isRowLive(tokenHash: string): Promise<boolean> {
        try {
            const rows = await this.sql<{ id: number }[]>`
        SELECT id FROM personal_access_tokens
        WHERE token_hash = ${tokenHash}
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
      `;
            return rows.length > 0;
        } catch (err) {
            logger.warn('PAT liveness check failed; rejecting until it can be confirmed', {
                error: String(err),
            });
            if (isDependencyError(err)) throw new AuthDependencyUnavailableError(err);
            return false;
        }
    }

    /** Drop the negative-cache entry so the next request re-checks Valkey. */
    private clearRevocationCheckCache(tokenHash: string): void {
        this.revocationCheckCache.delete(tokenHash);
    }

    /**
     * Cascade revocation to all stream sessions issued under this PAT hash.
     * Also publishes Valkey markers for the ended sessions so cached
     * validations on other replicas pick up the change quickly.
     */
    private async cascadeRevokeStreamSessions(
        patTokenHash: string,
        sql: Sql = this.sql,
    ): Promise<void> {
        try {
            const { getStreamingSessionService } =
                await import('$lib/server/oauth/streaming-session.service.js');
            const sessionService = getStreamingSessionService();
            const endedHashes = await withTx(sql, (tx) =>
                sessionService.endByParentTokenHash(patTokenHash, tx),
            );

            if (endedHashes.length > 0) {
                const { cacheSet, isCoordinationValkeyReady, connectValkey } =
                    await import('$lib/server/cache/valkey.js');
                if (!isCoordinationValkeyReady()) await connectValkey();
                for (const hash of endedHashes) {
                    await cacheSet(
                        STREAM_REVOCATION_KEY_PREFIX + hash,
                        '1',
                        Math.ceil(TOKEN_CACHE_TTL_MS / 1000),
                    ).catch(() => {
                        /* best-effort */
                    });
                }
            }
        } catch (err) {
            logger.warn('Failed to cascade stream session revocation from PAT', {
                error: String(err),
            });
        }
    }

    /**
     * List all active PATs for a user
     */
    async listForUser(userId: UserId, options?: { scopes?: string[] }): Promise<PatListItem[]> {
        const scopeFilter =
            options?.scopes && options.scopes.length > 0
                ? this
                      .sql`AND scopes @> ${options.scopes}::text[] AND array_length(scopes, 1) = ${options.scopes.length}`
                : this.sql``;

        const results = await this.sql<PatListRow[]>`
      SELECT
        id, name, description, token_prefix, scopes, allowed_ips,
        created_at, expires_at, last_used_at, last_used_ip, usage_count
      FROM personal_access_tokens
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
        ${scopeFilter}
      ORDER BY created_at DESC
    `;

        const now = new Date();
        return results.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            tokenPrefix: r.token_prefix,
            scopes: r.scopes || [],
            allowedIps: r.allowed_ips,
            createdAt: r.created_at,
            expiresAt: r.expires_at,
            lastUsedAt: r.last_used_at,
            lastUsedIp: r.last_used_ip,
            usageCount: r.usage_count,
            isExpired: r.expires_at ? new Date(r.expires_at) < now : false,
        }));
    }

    /**
     * List ALL PATs (admin only)
     * Optionally filter by userId and/or scopes
     */
    async listAll(options?: { scopes?: string[]; userId?: UserId }): Promise<AdminPatListItem[]> {
        const userId = options?.userId;
        const userFilter = userId ? this.sql`AND pat.user_id = ${userId}` : this.sql``;
        const scopeFilter =
            options?.scopes && options.scopes.length > 0
                ? this
                      .sql`AND pat.scopes @> ${options.scopes}::text[] AND array_length(pat.scopes, 1) = ${options.scopes.length}`
                : this.sql``;

        const results = await this.sql<PatListRow[]>`
        SELECT
          pat.id, pat.user_id, pat.name, pat.description, pat.token_prefix, pat.scopes,
          pat.allowed_ips, pat.created_at, pat.expires_at, pat.last_used_at,
          pat.last_used_ip, pat.usage_count, u.display_name AS owner_display_name
        FROM personal_access_tokens pat
        LEFT JOIN users u ON u.id = pat.user_id
        WHERE pat.revoked_at IS NULL
          ${userFilter}
          ${scopeFilter}
        ORDER BY u.username, pat.created_at DESC
      `;

        const avatars = await userImageSets(
            this.sql,
            'v1',
            results.flatMap((r) => (r.user_id ? [r.user_id] : [])),
            { external: false },
        );
        const now = new Date();
        return results.map((r) => ({
            id: r.id,
            // pat.user_id is a UUID FK (users.id) — always show the resolved
            // username, never the raw UUID. Empty string (LEFT JOIN miss, e.g.
            // a hard-deleted owner) is a display-layer fallback decision, not
            // this service's — the admin UI renders its own localized label.
            owner: toPublicAuthor(
                { userId: r.user_id!, displayName: r.owner_display_name ?? null },
                'v1',
                avatars.get(r.user_id!),
            ),
            name: r.name,
            description: r.description,
            tokenPrefix: r.token_prefix,
            scopes: r.scopes || [],
            allowedIps: r.allowed_ips,
            createdAt: r.created_at,
            expiresAt: r.expires_at,
            lastUsedAt: r.last_used_at,
            lastUsedIp: r.last_used_ip,
            usageCount: r.usage_count,
            isExpired: r.expires_at ? new Date(r.expires_at) < now : false,
        }));
    }

    /**
     * Revoke a PAT by ID (admin - can revoke any user's token)
     */
    async revokeAsAdmin(id: number): Promise<{ revoked: boolean; username?: string }> {
        // Get token info for logging and cache invalidation. Resolve the
        // owner's username here too — `user_id` is a UUID FK, never a display
        // name (this fed the audit log with raw UUIDs before the join).
        const existing = await this.sql<(PatTokenRow & { username: string | null })[]>`
      SELECT pat.token_hash, pat.user_id, u.username
      FROM personal_access_tokens pat
      LEFT JOIN users u ON u.id = pat.user_id
      WHERE pat.id = ${id} AND pat.revoked_at IS NULL
    `;

        if (existing.length === 0) {
            return { revoked: false };
        }

        // Order matters (mirrors service-token.service.ts):
        //   1. UPDATE revoked_at — DB now reflects revoked state.
        //   2. publishValkeyRevocation — broadcast to other replicas.
        //   3. tokenCache.delete (local) — last, so our own validate()'s
        //      cache-miss path either reads the now-revoked row OR sees
        //      the Valkey marker on its cache-miss revocation check.
        const result = await this.sql<PatIdRow[]>`
      UPDATE personal_access_tokens
      SET revoked_at = NOW()
      WHERE id = ${id}
        AND revoked_at IS NULL
      RETURNING id
    `;

        const tokenHash = existing[0].token_hash;
        await this.publishValkeyRevocation(tokenHash);
        this.tokenCache.delete(tokenHash);
        this.clearRevocationCheckCache(tokenHash);

        if (result.length > 0) {
            logger.info('PAT revoked by admin', {
                id,
                username: existing[0].username ?? existing[0].user_id,
            });
            await this.cascadeRevokeStreamSessions(tokenHash);
            return { revoked: true, username: existing[0].username ?? undefined };
        }

        return { revoked: false };
    }

    /**
     * Revoke a PAT by ID
     */
    async revoke(id: number, userId: UserId): Promise<boolean> {
        // Get token hash for cache invalidation
        const existing = await this.sql<PatTokenHashRow[]>`
      SELECT token_hash FROM personal_access_tokens
      WHERE id = ${id} AND user_id = ${userId}
    `;

        if (existing.length === 0) {
            return false;
        }

        // Order matters (mirrors service-token.service.ts):
        //   1. UPDATE revoked_at — DB now reflects revoked state.
        //   2. publishValkeyRevocation — broadcast to other replicas.
        //   3. tokenCache.delete (local) — last, so our own validate()'s
        //      cache-miss path either reads the now-revoked row OR sees
        //      the Valkey marker on its cache-miss revocation check.
        const result = await this.sql<PatIdRow[]>`
      UPDATE personal_access_tokens
      SET revoked_at = NOW()
      WHERE id = ${id}
        AND user_id = ${userId}
        AND revoked_at IS NULL
      RETURNING id
    `;

        const tokenHash = existing[0].token_hash;
        await this.publishValkeyRevocation(tokenHash);
        this.tokenCache.delete(tokenHash);
        this.clearRevocationCheckCache(tokenHash);

        if (result.length > 0) {
            logger.info('PAT revoked', { id, userId });
            await this.cascadeRevokeStreamSessions(tokenHash);
            return true;
        }

        return false;
    }

    /**
     * Revoke all PATs for a user
     */
    async revokeAllForUser(userId: UserId, sql: Sql = this.sql): Promise<number> {
        // Get all token hashes BEFORE the UPDATE — needed for both per-hash
        // cluster broadcast and the stream-session cascade. Mirrors the
        // contract from `revoke()` / `revokeAsAdmin()`.
        const tokens = await sql<PatTokenHashRow[]>`
      SELECT token_hash FROM personal_access_tokens
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
    `;

        const result = await sql<PatIdRow[]>`
      UPDATE personal_access_tokens
      SET revoked_at = NOW()
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
      RETURNING id
    `;

        // Order matches the single-token revoke paths: broadcast → local cache
        // delete → stream cascade. Per-hash so a Valkey transient failure on
        // one token doesn't abort the rest.
        for (const t of tokens) {
            await this.publishValkeyRevocation(t.token_hash);
            this.tokenCache.delete(t.token_hash);
            this.clearRevocationCheckCache(t.token_hash);
        }
        for (const t of tokens) {
            await this.cascadeRevokeStreamSessions(t.token_hash, sql);
        }

        if (result.length > 0) {
            logger.info('All PATs revoked for user', {
                userId,
                count: result.length,
            });
        }

        return result.length;
    }

    /**
     * Narrow the admin-class-scoped PATs for a user by flipping their
     * `force_non_admin` kill-switch — tokens whose `scopes` include `'admin'`
     * or any `<area>:admin` scope (`isAdminClassScope()`, the SAME predicate
     * the token-minting ceiling and `stripAdminScopes()` use — see
     * `principal.ts`). Ordinary `read`/`write`/`jellyfin_compat` PATs are
     * left untouched, and the token itself is NOT revoked: it keeps
     * authenticating and keeps every non-admin scope it always had (mirrors
     * `service_tokens.force_non_admin`, which has done exactly this for
     * service tokens since the minting-ceiling fix).
     *
     * Security review 2026-09-15, C4: `setIsAdmin(false)` / the unpin path
     * only ever wrote `users.is_admin` — they revoked/narrowed nothing. A
     * `{kind:'scope'}` def (`mount.ts`) reads `Principal.scopes`, never
     * `isAdmin`, and `Principal.scopes` for a PAT credential is
     * `expandScopes(<the token's OWN stored scopes>)` regardless of the
     * owner's CURRENT admin status — `buildPrincipal()` only strips admin
     * scopes for a `forceNonAdmin` token (`principal.ts`'s `deriveIsAdmin()` /
     * `stripAdminScopes()`), and until migration 16.255.0 PATs had no such
     * column to set. So a demoted admin's `admin`-scoped PAT kept full
     * `{kind:'scope'}` admin-plane access forever, independent of any
     * `isAdmin`/`ownerIsAdmin` fix. Called from the demotion and
     * unpin-that-demotes paths, never from promotion.
     *
     * Filtering happens in JS rather than as a SQL `scopes && ARRAY[...]`
     * predicate so there is exactly one place that decides what "admin-class"
     * means (`isAdminClassScope()`) — a hand-written SQL mirror of that rule
     * is exactly the kind of duplicated security decision this fix round is
     * meant to collapse, not add another copy of.
     *
     * CROSS-REPLICA: this replica's own `tokenCache` entry for each affected
     * hash is evicted immediately below, AND a `{kind:'token-narrowed'}`
     * event is published on the shared auth-cache-bus so every sibling
     * replica evicts its own cached entry too (security review 2026-09-16,
     * fix round 1 review — the demotion path already broadcasts the identity
     * half via `invalidateUserAdminCache`; the credential half must not be
     * the one part left replica-local). This is a plain LRU evict, not
     * `revoke()`'s `publishValkeyRevocation`/`pat-revoked:` channel — the
     * token is not being revoked, so reusing that "is this hash revoked?"
     * channel would be semantically wrong (401 instead of the intended
     * 403-via-narrowed-scope). See `onRemoteTokenNarrowedInvalidate()`'s doc
     * comment in `auth-cache-bus.ts` for the full mechanism.
     */
    async markAdminScopedForceNonAdminForUser(userId: UserId): Promise<number> {
        const tokens = await this.sql<
            Array<{ id: number; token_hash: string; scopes: string[] | null }>
        >`
      SELECT id, token_hash, scopes FROM personal_access_tokens
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
        AND force_non_admin = false
    `;

        const adminScoped = tokens.filter((t) => (t.scopes ?? []).some(isAdminClassScope));
        if (adminScoped.length === 0) return 0;

        const ids = adminScoped.map((t) => t.id);
        const result = await this.sql<PatIdRow[]>`
      UPDATE personal_access_tokens
      SET force_non_admin = true, force_non_admin_narrowed_at = NOW()
      WHERE id = ANY(${ids}::int[])
        AND revoked_at IS NULL
      RETURNING id
    `;

        for (const t of adminScoped) {
            this.tokenCache.delete(t.token_hash);
            publishAuthCacheInvalidation({ kind: 'token-narrowed', tokenHash: t.token_hash });
        }

        if (result.length > 0) {
            logger.info('Admin-scoped PATs narrowed (force_non_admin) for user', {
                userId,
                count: result.length,
            });
        }

        return result.length;
    }

    /**
     * The promotion-side counterpart to `markAdminScopedForceNonAdminForUser()`
     * — clears `force_non_admin` on every PAT this user owns that WE
     * narrowed (i.e. `force_non_admin_narrowed_at IS NOT NULL`). Called when
     * a demoted admin is RE-promoted.
     *
     * Security review 2026-09-16 (fix round 1 review, Important 5): nothing
     * previously reset this flag, so demote-then-re-promote permanently
     * stripped admin from a re-promoted admin's existing PATs — a token that
     * looked healthy (not revoked, still the same `scopes`) would 403 on
     * every admin-scope check forever, with no UI signal explaining why.
     *
     * The `force_non_admin_narrowed_at IS NOT NULL` guard (migration
     * 16.256.0, fix round 2 review, NEW Important 1) exists for PARITY with
     * `ServiceTokenService.clearForceNonAdminForUserAndCreator()`, where it
     * is load-bearing (a service token's `force_non_admin` can ALSO be an
     * operator's own mint-time choice — see that method's doc comment). PATs
     * have no mint-time `forceNonAdmin` param today (`CreatePatParams` has
     * none), so `force_non_admin = true` currently only ever comes from
     * narrowing — but gating on the same discriminator column here keeps the
     * two credential types' restore logic identical rather than one relying
     * on "there's currently nothing else that could set this".
     */
    async clearForceNonAdminForUser(userId: UserId): Promise<number> {
        const tokens = await this.sql<Array<{ id: number; token_hash: string }>>`
      SELECT id, token_hash FROM personal_access_tokens
      WHERE user_id = ${userId}
        AND force_non_admin = true
        AND force_non_admin_narrowed_at IS NOT NULL
    `;
        if (tokens.length === 0) return 0;

        const ids = tokens.map((t) => t.id);
        const result = await this.sql<PatIdRow[]>`
      UPDATE personal_access_tokens
      SET force_non_admin = false, force_non_admin_narrowed_at = NULL
      WHERE id = ANY(${ids}::int[])
      RETURNING id
    `;

        for (const t of tokens) {
            this.tokenCache.delete(t.token_hash);
            publishAuthCacheInvalidation({ kind: 'token-narrowed', tokenHash: t.token_hash });
        }

        if (result.length > 0) {
            logger.info('Admin-scoped PATs un-narrowed (force_non_admin cleared) for user', {
                userId,
                count: result.length,
            });
        }

        return result.length;
    }

    /**
     * Revoke all un-revoked `jellyfin_compat`-scoped PATs for a user that share
     * a given name. Used by /j/Auth/Keys to clear prior tokens when re-running
     * the Seerr/Jellyseerr setup wizard.
     *
     * Performs the full cleanup contract: cluster broadcast → local LRU evict
     * → negative-cache evict → stream-session cascade. Replaces the raw
     * UPDATE that previously bypassed all three.
     */
    async revokeJellyfinCompatByName(userId: UserId, name: string): Promise<number> {
        // RETURNING token_hash from the UPDATE closes the TOCTOU window — any
        // concurrent INSERT that the UPDATE catches is also in this result, so
        // its hash gets the full cleanup. A separate SELECT would miss those.
        const revoked = await this.sql<PatTokenHashRow[]>`
            UPDATE personal_access_tokens
            SET revoked_at = NOW()
            WHERE user_id = ${userId}
              AND name = ${name}
              AND scopes = ARRAY['jellyfin_compat']::text[]
              AND revoked_at IS NULL
            RETURNING token_hash
        `;

        for (const r of revoked) {
            await this.publishValkeyRevocation(r.token_hash);
            this.tokenCache.delete(r.token_hash);
            this.clearRevocationCheckCache(r.token_hash);
        }
        for (const r of revoked) {
            await this.cascadeRevokeStreamSessions(r.token_hash);
        }

        if (revoked.length > 0) {
            logger.info('Jellyfin Connect PATs revoked by name', {
                userId,
                name,
                count: revoked.length,
            });
        }
        return revoked.length;
    }

    /**
     * Check if a token string looks like a PAT
     */
    static isPatToken(token: string): boolean {
        return token.startsWith(PAT_PREFIX);
    }

    /**
     * Check if a validated PAT has a specific scope.
     *
     * WARNING: This treats `admin` as universal — every check passes for admin tokens.
     * DO NOT use this for `jellyfin_compat` / `jellyfin_compat_read` scope checks.
     * Both require exact-array-equality (e.g. `scopes.length === 1 && scopes[0] === 'jellyfin_compat'`).
     * Using `hasScope()` would let admin-scoped PATs authenticate at /j/* endpoints,
     * defeating the exclusive-scope security guarantee.
     *
     * For /j/* PAT validation, use `src/lib/server/proprietary/jellyfin-compat/pat-auth.ts` which
     * performs the exact-equality check.
     */
    hasScope(validated: ValidatedPat, requiredScope: string): boolean {
        // 'admin' scope implies all other scopes
        if (validated.scopes.includes('admin')) {
            return true;
        }
        // 'write' scope implies 'read'
        if (requiredScope === 'read' && validated.scopes.includes('write')) {
            return true;
        }
        return validated.scopes.includes(requiredScope);
    }

    /**
     * Get cache statistics
     */
    getCacheStats() {
        return this.tokenCache.getStats();
    }

    /**
     * Cleanup expired and old revoked tokens
     */
    async cleanup(): Promise<number> {
        const result = await this.sql<PatIdRow[]>`
      DELETE FROM personal_access_tokens
      WHERE
        (expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '7 days')
        OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '1 day')
      RETURNING id
    `;

        if (result.length > 0) {
            logger.info('Cleaned up old PATs', { count: result.length });
        }

        return result.length;
    }
}

// Singleton instance
let instance: PatService | null = null;

export function getPatService(): PatService {
    if (!instance) {
        instance = new PatService();
    }
    return instance;
}

/** Do not construct a new auth service just to flush an unused process. */
export async function flushPatUsage(): Promise<void> {
    await instance?.flushUsage();
}
