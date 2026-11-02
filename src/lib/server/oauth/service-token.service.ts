// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    AuthDependencyUnavailableError,
    isDependencyError,
} from '$lib/server/auth/dependency-unavailable.js';

import type { PublicAuthor } from '$lib/schemas/public-author.js';
import { loadPublicAuthors } from '$lib/server/utils/public-author.js';
// Service Token Service
// Manages admin-created API tokens for services and integrations

import { randomBytes, createHash } from 'crypto';
import type { Sql } from 'postgres';
import { withTx } from '../database/with-tx.js';
import { Database } from '../database/connection.js';
import { Logger } from '../utils/logger';
import { LRUCache } from '../cache/lru-cache';
import { standaloneCacheRegistry } from '../cache/standalone-registry';
import { cacheTtlUntilExpiry } from './token-cache-ttl.js';
import { normalizeIp } from './ip-literal.js';
import { warnRevocationMarkerUnavailable } from './revocation-marker-warning.js';
import type { UserId } from '$lib/shared/user-id.js';
import { isAdminClassScope } from '$lib/server/api/principal.js';
import {
    publishAuthCacheInvalidation,
    onRemoteTokenNarrowedInvalidate,
    onAuthCacheBusResync,
} from '$lib/server/cache/auth-cache-bus.js';
import { isLifecycleActive } from '$lib/server/auth/user-lifecycle.js';
import type { MinterEnvelope } from '$lib/server/api/service-token-mint-envelope.js';
import {
    SERVICE_TOKEN_GRANTS,
    serviceTokenMethodSchema,
    type ServiceTokenMethod,
    type ServiceTokenScope,
} from '$lib/schemas/admin.js';

const logger = Logger.for('OAuth:ServiceToken');

// Token prefix to distinguish from JWT and PATs
const SVC_PREFIX = 'svc_';

// Cache TTL for validated tokens (5 minutes)
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

// Maximum active service tokens system-wide (prevent resource exhaustion)
const MAX_SERVICE_TOKENS = 100;

/**
 * Hash a token using SHA-256 for secure storage
 */
function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * Check whether a client IP matches any entry in an allowlist.
 * Both sides are canonicalised ({@link normalizeIp}) before comparison.
 */
function isIpAllowed(clientIp: string | undefined, allowed: string[]): boolean {
    if (!clientIp) return false;
    const normalizedClient = normalizeIp(clientIp);
    return allowed.some((entry) => normalizeIp(entry) === normalizedClient);
}

// Valkey key prefix for cluster-wide revocation broadcasts.
// On revoke we write `${REVOCATION_KEY_PREFIX}${token_hash}` with TTL = cache TTL.
// Other replicas re-check this on every cache hit and evict their LRU.
const REVOCATION_KEY_PREFIX = 'svc-token-revoked:';

/**
 * Generate a service token (svc_ prefix + 48-char random hex)
 */
function generateServiceToken(): string {
    return SVC_PREFIX + randomBytes(24).toString('hex');
}

/** Token ids whose dropped stored scopes were already logged by this process. */
const warnedUnknownScopeTokenIds = new Set<number>();

/**
 * The view of a stored `scopes` column that request time, the minter envelope
 * and the API all use: only values of the closed grant enum. Rows minted
 * before the enum (free-form strings) may hold other values; they grant
 * nothing. With `tokenId`, a dropped value is logged once per token per process.
 */
function knownGrants(scopes: string[] | null, tokenId?: number): ServiceTokenScope[] {
    const known = (scopes ?? []).filter((s): s is ServiceTokenScope =>
        (SERVICE_TOKEN_GRANTS as readonly string[]).includes(s),
    );
    if (
        tokenId !== undefined &&
        scopes &&
        known.length !== scopes.length &&
        !warnedUnknownScopeTokenIds.has(tokenId)
    ) {
        warnedUnknownScopeTokenIds.add(tokenId);
        logger.warn(
            'Service token holds stored scopes outside the grant enum; they grant nothing',
            {
                tokenId,
                dropped: scopes.filter((s) => !(known as string[]).includes(s)),
            },
        );
    }
    return known;
}

/** Response-side view of a stored `allowed_methods` column (upper-cased, enum values only). */
function knownMethods(methods: string[] | null): ServiceTokenMethod[] {
    return (methods ?? []).flatMap((m) => {
        const parsed = serviceTokenMethodSchema.safeParse(m.toUpperCase());
        return parsed.success ? [parsed.data] : [];
    });
}

/**
 * Get first 12 characters of token for display (svc_XXXXXXXX)
 */
function getTokenPrefix(token: string): string {
    return token.substring(0, 12);
}

export interface ServiceTokenRecord {
    id: number;
    token_hash: string;
    token_prefix: string;
    name: string;
    description: string | null;
    created_by: string;
    owner_user_id: string | null;
    /** The service token that minted this one, or null when a user did (16.286.0). */
    created_via_token_id: number | null;
    act_as_user: string | null;
    scopes: string[];
    allowed_ips: string[] | null;
    allowed_path_prefixes: string[] | null;
    allowed_methods: string[] | null;
    force_non_admin: boolean;
    /**
     * When `force_non_admin` was set BY OUR OWN demotion-narrowing, `NULL`
     * when it is an operator's own mint-time choice (or unset). See
     * `markAdminScopedForceNonAdminImpersonating()` /
     * `clearForceNonAdminForUserAndCreator()` (migration 16.256.0).
     */
    force_non_admin_narrowed_at: Date | null;
    created_at: Date;
    expires_at: Date | null;
    revoked_at: Date | null;
    last_used_at: Date | null;
    last_used_ip: string | null;
    usage_count: number;
}

/**
 * Validated service-token shape returned from `validate()` and cached in the
 * LRU. Carries every per-token gate the request middleware needs so the
 * forward-auth handler doesn't re-fetch from DB on every request.
 */
export interface ValidatedServiceToken {
    id: number;
    name: string;
    /** Username label written at mint time. Audit only; never an identity. */
    createdBy: string;
    /**
     * `service_tokens.owner_user_id`: the owner, by id. `validate()` rejects a
     * token whose owner is null, missing, disabled or deleted, and the
     * non-impersonating identity and owner admin verdict are resolved from it.
     */
    ownerUserId: string | null;
    /**
     * Impersonation target as a stable `users.id` UUID (post mig-16.46.0), or null
     * for an admin (non-impersonating) token. forward-auth resolves it to the
     * username/groups by `users.id`.
     */
    actAsUser: string | null;
    allowedIps: string[] | null;
    /** Per-token route gate. Empty/null = any /api/v1/* path. */
    allowedPathPrefixes: string[] | null;
    /** Per-token method gate. Empty/null = any method. */
    allowedMethods: string[] | null;
    /** Force isAdmin=false on resolved user context regardless of target groups. */
    forceNonAdmin: boolean;
    /** Token scopes — enforced by the auth middleware (read = GET/HEAD only). */
    scopes: string[];
    tokenPrefix: string;
}

export interface CreateServiceTokenParams {
    name: string;
    description?: string;
    /**
     * Username of the user who owns the token (attribution; TEXT exception).
     * Always a real user: a token minted by a service token passes the
     * MINTER's `created_by` here, never `service:<name>`.
     */
    createdBy: string;
    ownerUserId?: string | null;
    /** Id of the service token that minted this one, when one did. */
    createdViaTokenId?: number;
    /**
     * Impersonation target as a stable `users.id` UUID. `service_tokens.act_as_user`
     * is `uuid REFERENCES users(id)` since mig 16.46.0 — the caller must resolve the
     * admin-supplied username to a UUID (e.g. `getUserIdByUsername`) before passing it.
     */
    actAsUser?: UserId;
    /**
     * Required. There is deliberately no default: an omitted scope list used
     * to mean `['admin']`, so a caller that forgot the field minted a
     * full-admin token (security review 2026-09-12, C3).
     */
    scopes: string[];
    allowedIps?: string[];
    allowedPathPrefixes?: string[];
    allowedMethods?: string[];
    forceNonAdmin?: boolean;
    expiresInDays?: number | null; // null = no expiration
    /**
     * Exact expiry; wins over `expiresInDays`. The mint-by-service-token path
     * passes the instant it checked against the minter's expiry.
     */
    expiresAt?: Date | null;
}

export interface ServiceTokenListItem {
    id: number;
    name: string;
    description: string | null;
    tokenPrefix: string;
    owner: PublicAuthor | null;
    actAsUserId: string | null;
    actAs: PublicAuthor | null;
    createdVia: { tokenId: number; tokenName: string } | null;
    scopes: ServiceTokenScope[];
    allowedIps: string[];
    allowedPathPrefixes: string[];
    allowedMethods: ServiceTokenMethod[];
    forceNonAdmin: boolean;
    createdAt: Date;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    usageCount: number;
    isExpired: boolean;
}

type ServiceTokenCountRow = { count: string };
type ServiceTokenIdRow = { id: number };
type ServiceTokenTokenRow = { token_hash: string };
type ServiceTokenListRow = {
    id: number;
    name: string;
    description: string | null;
    token_prefix: string;
    created_by: string;
    owner_user_id: string | null;
    created_via_token_id: number | null;
    created_via_token_name: string | null;
    act_as_user: string | null;
    /** Username resolved from `act_as_user` (users.id) for display — see listAll/getById join. */
    act_as_username: string | null;
    scopes: string[] | null;
    allowed_ips: string[] | null;
    allowed_path_prefixes: string[] | null;
    allowed_methods: string[] | null;
    force_non_admin: boolean | null;
    created_at: Date;
    expires_at: Date | null;
    last_used_at: Date | null;
    usage_count: number;
};

/** The token a new token is being minted through was revoked or expired meanwhile. */
export class MintingTokenRevokedError extends Error {
    constructor() {
        super('The minting token is no longer valid');
        this.name = 'MintingTokenRevokedError';
    }
}

export class ServiceTokenService {
    private readonly db: Database;
    private readonly sql: Sql;

    // LRU cache to avoid DB lookups on every request
    private readonly tokenCache: LRUCache<ValidatedServiceToken>;

    constructor() {
        this.db = new Database();
        this.sql = this.db.getSql();
        this.tokenCache = new LRUCache<ValidatedServiceToken>({
            maxSize: 100, // Service tokens are less common
            defaultTTL: TOKEN_CACHE_TTL_MS,
            namespace: 'service-token',
        });

        // Register cache for admin monitoring
        standaloneCacheRegistry.register({
            name: 'service-tokens',
            description: 'Validated admin Service Tokens',
            category: 'auth',
            cache: this.tokenCache,
        });

        // Cross-replica narrow/un-narrow propagation (security review
        // 2026-09-16, C4 fix round 1 review) — see auth-cache-bus.ts's
        // onRemoteTokenNarrowedInvalidate() doc comment. A no-op delete when
        // the broadcast hash belongs to a PAT instead.
        onRemoteTokenNarrowedInvalidate((tokenHash) => this.tokenCache.delete(tokenHash));
        // A narrow event published while the bus was down is lost: re-validate
        // every token after the bus comes back.
        onAuthCacheBusResync(() => this.tokenCache.clear());
    }

    /**
     * Create a new Service Token
     * Returns the plaintext token (only returned once!)
     */
    async create(params: CreateServiceTokenParams): Promise<{ token: string; id: number }> {
        // Check global service token limit
        const countResult = await this.sql<ServiceTokenCountRow[]>`
      SELECT COUNT(*) as count FROM service_tokens
      WHERE revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
    `;

        const currentCount = parseInt(countResult[0]?.count || '0', 10);
        if (currentCount >= MAX_SERVICE_TOKENS) {
            throw new Error(`Maximum of ${MAX_SERVICE_TOKENS} active service tokens allowed`);
        }

        // Generate token
        const token = generateServiceToken();
        const tokenHash = hashToken(token);
        const tokenPrefix = getTokenPrefix(token);

        // Calculate expiration
        let expiresAt: Date | null = null;
        if (params.expiresAt !== undefined) {
            expiresAt = params.expiresAt;
        } else if (params.expiresInDays !== null && params.expiresInDays !== undefined) {
            expiresAt = new Date(Date.now() + params.expiresInDays * 24 * 60 * 60 * 1000);
        }

        const scopes = params.scopes;
        if (!Array.isArray(scopes) || scopes.length === 0) {
            throw new Error('Service token scopes are required');
        }

        // Normalize empty arrays to null at the column level so listAll() and
        // the validate-time enforcement can use a single "is the gate set?"
        // check (`xs && xs.length > 0`). An empty array would silently match
        // nothing in the path-prefix gate and reject every request.
        const pathPrefixes =
            params.allowedPathPrefixes && params.allowedPathPrefixes.length > 0
                ? params.allowedPathPrefixes
                : null;
        const methods =
            params.allowedMethods && params.allowedMethods.length > 0
                ? params.allowedMethods
                : null;
        const forceNonAdmin = params.forceNonAdmin === true;
        // Stored canonical so the allowlist, the matcher and a minter
        // envelope's subset check all compare one spelling per address.
        const allowedIps =
            params.allowedIps && params.allowedIps.length > 0
                ? [...new Set(params.allowedIps.map(normalizeIp))]
                : null;

        // Minted through another token: insert only while that token is live,
        // holding a share lock on its row so a concurrent revoke() (whose root
        // UPDATE needs the row lock) waits for this insert and then cascades
        // over the new child. Without it the child could land after the
        // cascade walk and survive the revoke.
        const result = await this.sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as Sql;
            let ownerUserId = params.ownerUserId;
            if (params.createdViaTokenId != null) {
                const via = await tx<{ id: number; owner_user_id: string | null }[]>`
      SELECT id, owner_user_id FROM service_tokens
      WHERE id = ${params.createdViaTokenId}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      FOR SHARE
    `;
                if (via.length === 0) throw new MintingTokenRevokedError();
                // A minter without an owner (legacy / deleted human) must not leave
                // the child ownerless when its created_by names a known user:
                // `undefined` makes the INSERT resolve it from created_by below.
                ownerUserId = via[0].owner_user_id ?? undefined;
            }
            return tx<ServiceTokenIdRow[]>`
      INSERT INTO service_tokens (
        token_hash, token_prefix, name, description,
        created_by, owner_user_id, created_via_token_id, act_as_user, scopes, allowed_ips,
        allowed_path_prefixes, allowed_methods, force_non_admin,
        expires_at
      ) VALUES (
        ${tokenHash},
        ${tokenPrefix},
        ${params.name},
        ${params.description || null},
        ${params.createdBy},
        ${ownerUserId !== undefined ? ownerUserId : tx`(SELECT id FROM users WHERE LOWER(username) = LOWER(${params.createdBy}) LIMIT 1)`},
        ${params.createdViaTokenId ?? null},
        ${params.actAsUser || null},
        ${scopes},
        ${allowedIps},
        ${pathPrefixes},
        ${methods},
        ${forceNonAdmin},
        ${expiresAt}
      )
      RETURNING id
    `;
        });

        logger.info('Service token created', {
            id: result[0].id,
            name: params.name,
            createdBy: params.createdBy,
            createdViaTokenId: params.createdViaTokenId ?? null,
            tokenPrefix,
            actAsUser: params.actAsUser || '(admin)',
            scopes,
            allowedPathPrefixes: pathPrefixes ?? '(any)',
            allowedMethods: methods ?? '(any)',
            forceNonAdmin,
            expiresAt: expiresAt?.toISOString() || 'never',
        });

        return {
            token,
            id: result[0].id,
        };
    }

    /**
     * Validate a service token and return context
     * Updates last_used_at and usage_count
     */
    async validate(token: string, clientIp?: string): Promise<ValidatedServiceToken | null> {
        // Must start with svc_ prefix
        if (!token.startsWith(SVC_PREFIX)) {
            return null;
        }

        // Check cache first
        const tokenHash = hashToken(token);
        const cached = this.tokenCache.get(tokenHash);
        if (cached) {
            // Check Valkey-broadcast revocation. Without this, a token revoked
            // on replica A would still validate on replica B for up to 5 min
            // (LRU TTL). Service tokens carry admin priv, so we close that gap.
            const verdict = await this.checkValkeyRevocation(tokenHash);
            if (verdict === 'revoked') {
                this.tokenCache.delete(tokenHash);
                logger.info('Service token rejected: revoked on another replica', {
                    tokenPrefix: cached.tokenPrefix,
                });
                return null;
            }
            // The marker could not be consulted (Valkey down): the LRU entry
            // alone would keep a token revoked on another replica working for
            // the rest of the LRU TTL, so ask the row itself (one indexed
            // read, no usage write) — admin/users review 2026-10-07, item 2.
            if (verdict === 'unknown' && !(await this.isRowLive(tokenHash))) {
                this.tokenCache.delete(tokenHash);
                logger.info('Service token rejected: revoked or expired (marker unavailable)', {
                    tokenPrefix: cached.tokenPrefix,
                });
                return null;
            }

            // Check IP restriction if applicable
            // SECURITY: If IP whitelist is configured but no clientIp provided, reject
            if (cached.allowedIps && cached.allowedIps.length > 0) {
                if (!isIpAllowed(clientIp, cached.allowedIps)) {
                    logger.warn('Service token IP not allowed', {
                        tokenPrefix: cached.tokenPrefix,
                        clientIp: clientIp || '(unknown)',
                        reason: !clientIp ? 'no client IP provided' : 'IP not in whitelist',
                    });
                    return null;
                }
            }
            // Update usage async (fire and forget)
            void this.updateUsage(tokenHash, clientIp).catch(() => {
                /* Usage tracking is non-critical - don't block auth */
            });

            // SECURITY: re-check the owner's live status on EVERY validate()
            // call, cache hit or miss — mirrors PatService's owner re-check.
            // See isOwnerActive() for why this can't be folded into the
            // cached payload.
            if (!(await this.isOwnerActive(cached.ownerUserId))) {
                logger.warn('Service token rejected: owner missing, soft-deleted, or disabled', {
                    tokenPrefix: cached.tokenPrefix,
                    ownerUserId: cached.ownerUserId,
                });
                return null;
            }

            return cached;
        }

        // Query database
        const results = await this.sql<ServiceTokenRecord[]>`
      SELECT * FROM service_tokens
      WHERE token_hash = ${tokenHash}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
    `;

        if (results.length === 0) {
            logger.debug('Service token validation failed: token not found or expired');
            return null;
        }

        const record = results[0];

        // Check IP restriction
        // SECURITY: If IP whitelist is configured but no clientIp provided, reject
        if (record.allowed_ips && record.allowed_ips.length > 0) {
            if (!isIpAllowed(clientIp, record.allowed_ips)) {
                logger.warn('Service token IP not allowed', {
                    tokenPrefix: record.token_prefix,
                    clientIp: clientIp || '(unknown)',
                    allowedIps: record.allowed_ips,
                    reason: !clientIp ? 'no client IP provided' : 'IP not in whitelist',
                });
                return null;
            }
        }

        // Cache-miss revocation check: another replica may have written a
        // revocation marker AFTER we issued the SELECT but before we cache
        // the row (small window when revoke()'s UPDATE has not yet
        // committed but the broadcast has propagated). Without this, a
        // concurrent revoke could be undone by re-caching the un-revoked
        // record.
        if ((await this.checkValkeyRevocation(tokenHash)) === 'revoked') {
            logger.info('Service token rejected: revoked on another replica (cache-miss path)', {
                tokenPrefix: record.token_prefix,
            });
            return null;
        }

        // Build validated payload. allowed_path_prefixes / allowed_methods /
        // force_non_admin enforcement is performed by the shared
        // `$lib/server/auth/token-identity.ts` producer (fix-plan-5 Task 3),
        // reached from forward-auth.ts (/api/v1 PRIMARY), the
        // resolve-bearer-principal.ts /api/admin TERTIARY fallback, and
        // tasks/api-auth.ts's authenticate() {kind:'scope'} fallback alike —
        // not forward-auth.ts alone, which is what let the envelope go
        // unenforced on the other two planes (security review 5, C2). We
        // carry the raw column values here so the cache entry has everything
        // needed without a second DB round-trip.
        const validated: ValidatedServiceToken = {
            id: record.id,
            name: record.name,
            createdBy: record.created_by,
            ownerUserId: record.owner_user_id ?? null,
            actAsUser: record.act_as_user,
            allowedIps: record.allowed_ips,
            allowedPathPrefixes:
                record.allowed_path_prefixes && record.allowed_path_prefixes.length > 0
                    ? record.allowed_path_prefixes
                    : null,
            allowedMethods:
                record.allowed_methods && record.allowed_methods.length > 0
                    ? record.allowed_methods
                    : null,
            forceNonAdmin: record.force_non_admin === true,
            // A row with no recorded scopes grants nothing — never "admin".
            // (The column default is ARRAY['admin'] and create() always writes
            // the list, so this only guards a hand-edited row.) A stored value
            // outside the closed grant enum grants nothing either, so request
            // time never honours a scope the API cannot publish.
            scopes: knownGrants(record.scopes, record.id),
            tokenPrefix: record.token_prefix,
        };

        // Release review 2026-10-21 (finding 2): no known grant left means no
        // grant. buildPrincipal() reads an empty scope list as "session-like
        // read+write", so such a row must never reach a request.
        if (validated.scopes.length === 0) {
            logger.warn('Service token rejected: no known grant in its stored scopes', {
                tokenPrefix: record.token_prefix,
            });
            return null;
        }

        // Update usage
        await this.updateUsage(tokenHash, clientIp);

        // SECURITY: deny when the owner (service_tokens.owner_user_id) is
        // unknown, disabled or soft-deleted. See isOwnerActive() for the full
        // rationale — this applies to BOTH impersonating and
        // non-impersonating tokens, since impersonation authority is itself
        // granted by the owner.
        if (!(await this.isOwnerActive(validated.ownerUserId))) {
            logger.warn('Service token rejected: owner missing, soft-deleted, or disabled', {
                tokenPrefix: record.token_prefix,
                ownerUserId: validated.ownerUserId,
            });
            return null;
        }

        // Cache only an accepted token: a cached rejected row would keep its
        // stale owner for the LRU TTL after a repair and the cache-hit path
        // would reject it again.
        this.tokenCache.set(
            tokenHash,
            validated,
            cacheTtlUntilExpiry(record.expires_at, TOKEN_CACHE_TTL_MS),
        );

        logger.debug('Service token validated', {
            name: record.name,
            tokenPrefix: record.token_prefix,
            actAsUser: record.act_as_user || '(admin)',
        });

        return validated;
    }

    /**
     * Deny a service token when its owner (`service_tokens.owner_user_id`) is
     * unknown, disabled or soft-deleted. A non-impersonating token acts for
     * the owner (see `token-identity.ts`); an impersonating token's authority
     * to act on someone else's behalf is still GRANTED BY the owner, so both
     * must stop working the instant the owner is cut off.
     *
     * By id, never by the `created_by` username label: a renamed owner keeps
     * the token, and a different user who later takes the old name gains no
     * say over it. `owner_user_id IS NULL` (owner deleted — the FK is
     * `ON DELETE SET NULL` — or never resolvable) rejects.
     *
     * Implemented ONCE here so every consumer (forward-auth's
     * `handleServiceTokenAuth`, the shared `resolveBearerAdminPrincipal()`
     * helper, tasks/api-auth.ts's `authenticate()`) inherits it through
     * `validate()`.
     *
     * Runs on EVERY `validate()` call, not just cache misses — the owner's
     * status can change (disabled) without the token cache entry itself
     * being touched.
     *
     * Fails CLOSED on a DB error, matching `PatService`'s owner check.
     */
    private async isOwnerActive(ownerUserId: string | null | undefined): Promise<boolean> {
        if (!ownerUserId) return false;
        try {
            const rows = await this.sql<{ disabled_at: Date | null; deleted_at: Date | null }[]>`
        SELECT disabled_at, deleted_at FROM users
        WHERE id = ${ownerUserId}::uuid
      `;
            return rows.length > 0 && isLifecycleActive(rows[0]);
        } catch (error) {
            logger.error(
                'Service token validation: owner lookup failed; denying token',
                error instanceof Error ? error : new Error(String(error)),
                { ownerUserId },
            );
            if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
            return false;
        }
    }

    /**
     * Update last_used_at, last_used_ip, and usage_count
     */
    private async updateUsage(tokenHash: string, clientIp?: string): Promise<void> {
        try {
            await this.sql`
        UPDATE service_tokens
        SET
          last_used_at = NOW(),
          last_used_ip = ${clientIp || null},
          usage_count = usage_count + 1
        WHERE token_hash = ${tokenHash}
      `;
        } catch (error) {
            logger.warn('Failed to update service token usage', {
                error: String(error),
            });
        }
    }

    /**
     * List all active service tokens
     */
    async listAll(): Promise<ServiceTokenListItem[]> {
        const results = await this.sql<ServiceTokenListRow[]>`
      SELECT
        st.id, st.name, st.description, st.token_prefix, st.created_by, st.owner_user_id,
        st.created_via_token_id, via.name AS created_via_token_name,
        st.act_as_user, u.username AS act_as_username, st.scopes, st.allowed_ips,
        st.allowed_path_prefixes, st.allowed_methods, st.force_non_admin,
        st.created_at, st.expires_at, st.last_used_at, st.usage_count
      FROM service_tokens st
      LEFT JOIN users u ON u.id = st.act_as_user
      LEFT JOIN service_tokens via ON via.id = st.created_via_token_id
      WHERE st.revoked_at IS NULL
      ORDER BY st.created_at DESC
    `;

        const authors = await loadPublicAuthors(
            results.flatMap((r) =>
                [r.owner_user_id, r.act_as_user].filter((id): id is string => !!id),
            ),
        );
        const now = new Date();
        return results.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            tokenPrefix: r.token_prefix,
            owner: r.owner_user_id ? (authors.get(r.owner_user_id) ?? null) : null,
            actAsUserId: r.act_as_user,
            actAs: r.act_as_user ? (authors.get(r.act_as_user) ?? null) : null,
            createdVia:
                r.created_via_token_id != null && r.created_via_token_name != null
                    ? { tokenId: r.created_via_token_id, tokenName: r.created_via_token_name }
                    : null,
            scopes: knownGrants(r.scopes),
            allowedIps: r.allowed_ips ?? [],
            allowedPathPrefixes: r.allowed_path_prefixes ?? [],
            allowedMethods: knownMethods(r.allowed_methods),
            forceNonAdmin: r.force_non_admin === true,
            createdAt: r.created_at,
            expiresAt: r.expires_at,
            lastUsedAt: r.last_used_at,
            usageCount: r.usage_count,
            isExpired: r.expires_at ? new Date(r.expires_at) < now : false,
        }));
    }

    /**
     * Get a single service token by ID
     */
    async getById(id: number): Promise<ServiceTokenListItem | null> {
        const results = await this.sql<ServiceTokenListRow[]>`
      SELECT
        st.id, st.name, st.description, st.token_prefix, st.created_by, st.owner_user_id,
        st.created_via_token_id, via.name AS created_via_token_name,
        st.act_as_user, u.username AS act_as_username, st.scopes, st.allowed_ips,
        st.allowed_path_prefixes, st.allowed_methods, st.force_non_admin,
        st.created_at, st.expires_at, st.last_used_at, st.usage_count
      FROM service_tokens st
      LEFT JOIN users u ON u.id = st.act_as_user
      LEFT JOIN service_tokens via ON via.id = st.created_via_token_id
      WHERE st.id = ${id}
        AND st.revoked_at IS NULL
    `;

        if (results.length === 0) {
            return null;
        }

        const r = results[0];
        const authors = await loadPublicAuthors(
            results.flatMap((r) =>
                [r.owner_user_id, r.act_as_user].filter((id): id is string => !!id),
            ),
        );
        const now = new Date();
        return {
            id: r.id,
            name: r.name,
            description: r.description,
            tokenPrefix: r.token_prefix,
            owner: r.owner_user_id ? (authors.get(r.owner_user_id) ?? null) : null,
            actAsUserId: r.act_as_user,
            actAs: r.act_as_user ? (authors.get(r.act_as_user) ?? null) : null,
            createdVia:
                r.created_via_token_id != null && r.created_via_token_name != null
                    ? { tokenId: r.created_via_token_id, tokenName: r.created_via_token_name }
                    : null,
            scopes: knownGrants(r.scopes),
            allowedIps: r.allowed_ips ?? [],
            allowedPathPrefixes: r.allowed_path_prefixes ?? [],
            allowedMethods: knownMethods(r.allowed_methods),
            forceNonAdmin: r.force_non_admin === true,
            createdAt: r.created_at,
            expiresAt: r.expires_at,
            lastUsedAt: r.last_used_at,
            usageCount: r.usage_count,
            isExpired: r.expires_at ? new Date(r.expires_at) < now : false,
        };
    }

    /**
     * The calling service token's own row, for minting a token through it
     * (`POST /service-tokens` with a service-token caller). Null when it is
     * revoked or expired — the caller just authenticated with it, so that is
     * only a race with a revoke.
     */
    async getMinterEnvelope(id: number): Promise<MinterEnvelope | null> {
        const rows = await this.sql<ServiceTokenRecord[]>`
      SELECT * FROM service_tokens
      WHERE id = ${id}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
    `;
        const r = rows[0];
        if (!r) return null;
        return {
            id: r.id,
            name: r.name,
            createdBy: r.created_by,
            ownerUserId: r.owner_user_id ?? null,
            actAsUser: r.act_as_user,
            // The same filtered view validate() hands request time.
            scopes: knownGrants(r.scopes, r.id),
            allowedIps: r.allowed_ips,
            allowedPathPrefixes: r.allowed_path_prefixes,
            allowedMethods: r.allowed_methods,
            forceNonAdmin: r.force_non_admin === true,
            expiresAt: r.expires_at,
        };
    }

    /**
     * Revoke a service token by ID, and every token minted through it.
     *
     * The root UPDATE and the descendant walk run in ONE transaction, and the
     * walk runs even when the root is already revoked: a crash between two
     * separate statements used to leave the root revoked with live children,
     * and a retry returned early without ever cascading. The root UPDATE also
     * takes the row lock that `create()`'s `FOR SHARE` on the minting token
     * waits for, so a child minted
     * concurrently is either refused or visible to the walk.
     *
     * Order after commit: broadcast the Valkey markers, then evict locally —
     * a local validate() between eviction and commit would re-cache the
     * un-revoked row otherwise.
     *
     * Returns true when the root itself was live and is now revoked.
     */
    async revoke(id: number): Promise<boolean> {
        const { root, descendants } = await this.sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as Sql;
            const root = await tx<ServiceTokenTokenRow[]>`
      UPDATE service_tokens
      SET revoked_at = NOW()
      WHERE id = ${id}
        AND revoked_at IS NULL
      RETURNING token_hash
    `;
            const descendants = await this.revokeMintedThroughIds(tx, [id]);
            return { root, descendants };
        });

        await this.broadcastAndEvict([
            ...root.map((r) => r.token_hash),
            ...descendants.map((d) => d.token_hash),
        ]);

        if (descendants.length > 0) {
            logger.info('Service tokens minted through a revoked token revoked', {
                rootId: id,
                ids: descendants.map((d) => d.id),
            });
        }
        if (root.length > 0) {
            logger.info('Service token revoked', { id, descendantsRevoked: descendants.length });
            return true;
        }
        return false;
    }

    /**
     * Revoke every token minted THROUGH the given tokens (`created_via_token_id`),
     * transitively. A token that can mint (`admin` scope) that leaks lets the
     * holder mint children; revoking only the parent would leave those
     * children — each inside the parent's envelope, so each as powerful as
     * the parent — working until they expire (admin/users review 2026-10-07,
     * item 1). Children carry the parent's owner as `created_by`, so nothing
     * else ties them to the parent.
     *
     * The walk passes through already-revoked intermediate rows; `UNION`
     * (not `UNION ALL`) keeps it finite on a cycle. Already-revoked rows keep
     * their original `revoked_at`. Runs on the caller's transaction; the
     * caller broadcasts the returned hashes after commit.
     */
    private async revokeMintedThroughIds(
        tx: Sql,
        rootIds: number[],
    ): Promise<{ id: number; token_hash: string }[]> {
        if (rootIds.length === 0) return [];
        return tx<{ id: number; token_hash: string }[]>`
      WITH RECURSIVE minted AS (
        SELECT id FROM service_tokens WHERE created_via_token_id = ANY(${rootIds}::int[])
        UNION
        SELECT st.id FROM service_tokens st
        JOIN minted m ON st.created_via_token_id = m.id
      )
      UPDATE service_tokens
      SET revoked_at = NOW()
      WHERE id IN (SELECT id FROM minted)
        AND revoked_at IS NULL
      RETURNING id, token_hash
    `;
    }

    /**
     * Broadcast revocation markers, then evict the local LRU entries. One
     * import and at most one connect attempt for the whole batch, markers set
     * in parallel: a cascade used to await a connect per descendant while
     * Valkey flapped. Best-effort like publishValkeyRevocation().
     */
    private async broadcastAndEvict(tokenHashes: string[]): Promise<void> {
        if (tokenHashes.length > 0) {
            try {
                const { cacheSet, isCoordinationValkeyReady, connectValkey } =
                    await import('$lib/server/cache/valkey.js');
                if (!isCoordinationValkeyReady()) await connectValkey();
                const ttl = Math.ceil(TOKEN_CACHE_TTL_MS / 1000);
                const results = await Promise.allSettled(
                    tokenHashes.map((h) => cacheSet(REVOCATION_KEY_PREFIX + h, '1', ttl)),
                );
                const failed = results.filter((r) => r.status === 'rejected').length;
                if (failed > 0) {
                    logger.warn('Service token revocation broadcast partly failed', {
                        failed,
                        total: tokenHashes.length,
                    });
                }
            } catch (err) {
                logger.warn(
                    'Service token revocation broadcast failed; relying on per-replica LRU TTL',
                    { error: String(err) },
                );
            }
        }
        for (const h of tokenHashes) this.tokenCache.delete(h);
    }

    /**
     * Revoke every active service token that impersonates a given user
     * (`act_as_user = userId`). Called when the impersonated user is
     * disabled, password-reset, or deleted — a stolen/left-over impersonation
     * grant must not keep acting as that account once it's cut off.
     * Non-impersonating (admin) tokens are untouched.
     */
    async revokeAllImpersonating(userId: UserId, sql: Sql = this.sql): Promise<number> {
        // Revoke the impersonating tokens and everything minted through them
        // in one transaction (a child minted through an impersonating token
        // need not impersonate the same user), then broadcast.
        const { result, descendants } = await withTx(sql, async (tx) => {
            const result = await tx<{ id: number; token_hash: string }[]>`
      UPDATE service_tokens
      SET revoked_at = NOW()
      WHERE act_as_user = ${userId}
        AND revoked_at IS NULL
      RETURNING id, token_hash
    `;
            const descendants = await this.revokeMintedThroughIds(
                tx,
                result.map((r) => r.id),
            );
            return { result, descendants };
        });

        await this.broadcastAndEvict([
            ...result.map((t) => t.token_hash),
            ...descendants.map((t) => t.token_hash),
        ]);

        if (result.length > 0) {
            logger.info('All service tokens impersonating user revoked', {
                userId,
                count: result.length,
                descendantsRevoked: descendants.length,
            });
        }

        return result.length;
    }

    /**
     * Narrow every admin-class-scoped service token BELONGING to a demoted
     * admin, by flipping their EXISTING `force_non_admin` kill-switch —
     * tokens whose `scopes` include `'admin'` or any `<area>:admin` scope
     * (`isAdminClassScope()`, the SAME predicate the minting ceiling and
     * `stripAdminScopes()` use — see `principal.ts`). A non-admin-scoped
     * grant is left untouched, and the token is NOT revoked — it keeps
     * authenticating with every non-admin scope it always had.
     *
     * "Belonging to" is TWO distinct relationships, and — since security
     * review 5, fix-plan-5 Task 4 (Q8) — this method covers a token that
     * matches EITHER, INCLUDING BOTH AT ONCE (a token can now be narrowed for
     * two independent reasons; see the reason-flag note below):
     *   1. `act_as_user = userId` — a token IMPERSONATING the demoted user.
     *   2. `owner_user_id = userId` — an admin token the
     *      demoted user MINTED while still an admin, impersonating anyone or
     *      no one. The shared producer's (`token-identity.ts`, formerly a
     *      private `forward-auth.ts` copy) non-impersonating branch already
     *      re-resolves the CREATOR's admin status on every request via the
     *      shared `resolveOwnerIsAdminFailClosed()` (security review
     *      2026-09-15 C3; collapsed from a private per-file copy and folded
     *      into Formula A by the 2026-09-23 C6 fix) — so `Principal.isAdmin`
     *      is already correctly `false` for this token once its creator is
     *      demoted — but `Principal.scopes` is not: `{kind:'scope'}` defs
     *      read `Principal.scopes`, which stays the token's own literal
     *      `['admin']` (etc.) forever, regardless of the creator's current
     *      status, UNLESS `forceNonAdmin` strips it. Exactly the C4 pattern.
     *      Matched by `owner_user_id`, never the `created_by` username
     *      label (a rename must not detach the token from its owner).
     *
     *      Until fix-plan-5 Task 4, arm 2 additionally required
     *      `act_as_user IS NULL`, so a token impersonating a STILL-admin
     *      colleague, minted by an admin who is later demoted, kept full
     *      admin authority forever on BOTH surfaces once Shape A made both
     *      planes judge the impersonation TARGET — an outage-class gap (Q8):
     *      the authority to mint the token came from the CREATOR's own admin
     *      status (`denyUnlessMayMint`'s `targetIsAdmin` check only gates
     *      granting admin to the TARGET, not the creator's own standing),
     *      so a demoted creator must not keep it live.
     *
     * Security review 2026-09-15, C4: the admin-demotion / unpin paths must
     * not leave EITHER kind of token still resolving `{kind:'scope'}` admin
     * defs. Unlike PATs (which needed migration 16.255.0 to grow this
     * column), service tokens have carried `force_non_admin` since the
     * minting-ceiling fix — this is the first WRITER of it from outside
     * token creation, and reuses `principal.ts`'s existing `deriveIsAdmin()`
     * / `stripAdminScopes()` handling rather than adding a second mechanism.
     * Filtering happens in JS against the one canonical `isAdminClassScope()`
     * predicate rather than a hand-written SQL mirror of the same rule.
     *
     * REASON FLAGS (migration 16.263.0): a token whose `act_as_user` is one
     * demoted admin and whose `created_by` is ANOTHER (independently
     * demoted) admin can now be matched by BOTH arms, at different times,
     * from different calls. `force_non_admin_narrowed_by_target` /
     * `_by_creator` record WHICH relationship(s) actually applied, OR-ed
     * onto whatever was already recorded — never cleared here, only ever
     * set. This is load-bearing for `clearForceNonAdminForUserAndCreator()`:
     * without it, re-promoting ONE of the two parties would blindly clear
     * `force_non_admin` while the OTHER party is still demoted.
     *
     * The flags are updated on a token that is ALREADY `force_non_admin` from
     * the OTHER relationship (`force_non_admin_narrowed_at IS NOT NULL` — WE
     * set it), so a second, independent narrowing reason is recorded even
     * though `force_non_admin` itself doesn't change. They are NEVER touched
     * on a token that is `force_non_admin` for an unrelated, OPERATOR-chosen
     * reason (mint-time `forceNonAdmin: true`, `force_non_admin_narrowed_at
     * IS NULL`) — that token is excluded from this method entirely, exactly
     * as it always was, since tagging it with a narrowing reason would make
     * `clearForceNonAdminForUserAndCreator()`'s `IS NOT NULL` guard start
     * matching a row it must never touch.
     *
     * CROSS-REPLICA: publishes `{kind:'token-narrowed'}` on the shared
     * auth-cache-bus (security review 2026-09-16, fix round 1 review,
     * Important 1) so every replica evicts its cached entry, not just this
     * one — see `PatService.markAdminScopedForceNonAdminForUser()` /
     * `auth-cache-bus.ts`'s `onRemoteTokenNarrowedInvalidate()` for the full
     * reasoning (this is a plain LRU evict, not `revoke()`'s
     * `publishValkeyRevocation` channel). fix-plan-5 Task 9 review round 1,
     * Minor 2: this now fires for EVERY row the narrowing `UPDATE`'s
     * `RETURNING` touched (carried C3), not only the `newlyNarrowed` subset
     * — see that fix's own comment on the eviction loop below for why.
     */
    async markAdminScopedForceNonAdminImpersonating(
        userId: UserId,
        username: string,
    ): Promise<number> {
        const tokens = await this.sql<
            Array<{
                id: number;
                token_hash: string;
                scopes: string[] | null;
                force_non_admin: boolean;
                force_non_admin_narrowed_at: Date | null;
                matches_target: boolean;
                matches_creator: boolean;
            }>
        >`
      SELECT id, token_hash, scopes, force_non_admin, force_non_admin_narrowed_at,
             (act_as_user = ${userId}) AS matches_target,
             (owner_user_id IS NOT DISTINCT FROM ${userId}::uuid) AS matches_creator
      FROM service_tokens
      WHERE (
              act_as_user = ${userId}
              OR owner_user_id = ${userId}
            )
        AND revoked_at IS NULL
    `;

        const adminScoped = tokens.filter((t) => (t.scopes ?? []).some(isAdminClassScope));
        // Exclude a token that is force_non_admin for an OPERATOR-chosen
        // reason (mint-time, narrowed_at still NULL) — never tag it with a
        // narrowing reason; see the REASON FLAGS doc above.
        const updatable = adminScoped.filter(
            (t) => t.force_non_admin === false || t.force_non_admin_narrowed_at !== null,
        );
        if (updatable.length === 0) return 0;

        const targetIds = updatable.filter((t) => t.matches_target).map((t) => t.id);
        const creatorIds = updatable.filter((t) => t.matches_creator).map((t) => t.id);
        const allIds = updatable.map((t) => t.id);
        // Snapshot from the SELECT, used only to classify "newly narrowed"
        // (for the return count / log). The UPDATE below — WITH its own
        // `revoked_at IS NULL` re-check — is the actual source of truth for
        // which rows were touched; a row revoked between the SELECT and this
        // UPDATE is excluded from `updated` and therefore never evicted or
        // counted (fix round 1, Minor b).
        const wasUnnarrowed = new Set(
            updatable.filter((t) => t.force_non_admin === false).map((t) => t.id),
        );

        const updated = await this.sql<Array<{ id: number; token_hash: string }>>`
      UPDATE service_tokens
      SET force_non_admin = true,
          force_non_admin_narrowed_at = COALESCE(force_non_admin_narrowed_at, NOW()),
          force_non_admin_narrowed_by_target =
              force_non_admin_narrowed_by_target OR (id = ANY(${targetIds}::int[])),
          force_non_admin_narrowed_by_creator =
              force_non_admin_narrowed_by_creator OR (id = ANY(${creatorIds}::int[]))
      WHERE id = ANY(${allIds}::int[])
        AND revoked_at IS NULL
      RETURNING id, token_hash
    `;

        const newlyNarrowed = updated.filter((t) => wasUnnarrowed.has(t.id));

        // Evict/broadcast for EVERY row this UPDATE actually touched, not
        // just the SELECT-snapshot's `wasUnnarrowed` subset (fix-plan-5
        // Task 9, carried C3): a concurrent restore + re-cache between the
        // SELECT and this UPDATE could re-narrow a token whose cache entry
        // was just refreshed as un-narrowed — such a row is excluded from
        // `wasUnnarrowed` (the SELECT saw it as already force_non_admin)
        // but the UPDATE's RETURNING, the actual source of truth for what
        // the DB now holds, still includes it. Evicting only the
        // SELECT-based subset would leave that row's cache entry stale
        // (un-narrowed) until TTL even though the DB row is (re-)narrowed.
        for (const t of updated) {
            this.tokenCache.delete(t.token_hash);
            publishAuthCacheInvalidation({ kind: 'token-narrowed', tokenHash: t.token_hash });
        }

        if (newlyNarrowed.length > 0) {
            logger.info('Admin-scoped service tokens narrowed (force_non_admin) for user', {
                userId,
                username,
                count: newlyNarrowed.length,
            });
        }

        return newlyNarrowed.length;
    }

    /**
     * The promotion-side counterpart to
     * `markAdminScopedForceNonAdminImpersonating()` — clears `force_non_admin`
     * on every service token belonging to this user (impersonating them, OR
     * created by them, or both) that WE narrowed FOR THAT RELATIONSHIP.
     * Called when a demoted admin is RE-promoted.
     *
     * Security review 2026-09-16 (fix round 1 review, Important 5): see
     * `PatService.clearForceNonAdminForUser()` for the "nothing reset the
     * flag" rationale.
     *
     * `AND force_non_admin_narrowed_at IS NOT NULL` (migration 16.256.0, fix
     * round 2 review, NEW Important 1) is LOAD-BEARING here, unlike on the
     * PAT sibling: `service_tokens.force_non_admin` is ALSO a genuine,
     * operator-facing, mint-time column (`CreateServiceTokenParams
     * .forceNonAdmin`, the "Force non-admin (least-privilege kill switch)"
     * checkbox in the admin token UI — explicitly recommended for tokens
     * handed to less-trusted systems like Grafana or Uptime Kuma). Before
     * this guard, ANY admin-status write on a token's `act_as_user` (or
     * creator) — including a plain re-promotion, or even a REDUNDANT
     * `PATCH {isAdmin:true}` on someone already admin — cleared
     * `force_non_admin` unconditionally, silently un-sandboxing a token an
     * operator had deliberately locked down. `mount.ts` explicitly supports
     * an admin-scoped-but-`forceNonAdmin` token as a real, intentional
     * combination — this method must never be the thing that undoes it.
     *
     * TWO-REASON SAFETY (migration 16.263.0, fix-plan-5 Task 4, Q8): since a
     * token's `act_as_user` and `created_by` can now be TWO INDEPENDENTLY
     * demoted admins (see the reason-flag note on the narrowing method),
     * this method must restore ONLY the relationship matching `(userId,
     * username)` and leave `force_non_admin` set if the OTHER relationship
     * is still recorded as a narrowing reason: it clears ONLY the reason
     * flag(s) this call's own relationship owns (per row — a row that
     * matches only `act_as_user` never touches its `_by_creator` flag, and
     * vice versa), and flips `force_non_admin` back to `false` (and
     * `force_non_admin_narrowed_at` back to `NULL`) ONLY for rows where BOTH
     * flags are now clear. A token still flagged narrowed by the OTHER
     * relationship keeps `force_non_admin = true` — restoring one demoted
     * party must never un-narrow a token whose OTHER party is still demoted.
     *
     * ATOMIC AND CONCURRENCY-SAFE (fix-plan-5 Task 9, carried C2; Task 9
     * review round 1, CRITICAL). This used to be two separate `UPDATE`s —
     * clear the reason flag(s), then a second `UPDATE` flipping
     * `force_non_admin` when both flags read back false. A crash between
     * them stranded a row with `force_non_admin=true`,
     * `force_non_admin_narrowed_at` still set, and BOTH reason flags already
     * cleared — a shape this method's own WHERE clause can never match
     * again on any future call, so the row stayed narrowed forever.
     *
     * The first one-statement fix folded both writes into a single
     * `UPDATE ... FROM candidates` where `candidates` was a CTE
     * pre-computing each row's post-clear flags. That closed the CRASH
     * window but opened a CONCURRENT-WRITER one: under READ COMMITTED, when
     * this statement's target row is locked by a concurrent `UPDATE` (e.g.
     * the narrowing method setting the OTHER reason flag) and must wait,
     * PostgreSQL's EvalPlanQual re-fetches only the ROW BEING UPDATED once
     * the lock is released — it does NOT re-evaluate a JOINed/FROM-clause
     * subquery (the CTE) against the new row; that subquery keeps the
     * values it read BEFORE the wait. So `candidates.new_by_target`/
     * `new_by_creator` were computed from a STALE snapshot, and this
     * statement could silently overwrite a reason flag the other,
     * now-committed transaction had just set — reproduced: session 1
     * narrows via the CREATOR relationship (sets `by_creator=true`) and
     * holds the row locked; session 2 (this method) restores the TARGET
     * relationship, blocks, then wakes with the CTE still showing
     * `by_creator=false` from before session 1 committed — the creator's
     * narrowing is erased and the token goes back to admin (fails OPEN;
     * the creator flag is the only thing stopping a demoted creator's
     * impersonation token from keeping admin authority).
     *
     * Fixed by dropping the CTE/JOIN entirely: every expression below (SET,
     * WHERE, and RETURNING, which reads the column values `SET` just wrote)
     * references the target table's OWN columns directly, with no other
     * relation in the query. This is the case EvalPlanQual DOES handle
     * correctly — a plain single-table `UPDATE` re-evaluates every
     * expression against the freshly-locked row once a concurrent writer
     * commits, exactly like `x = x + 1` is safe under concurrent
     * increments. The statement is still ONE round trip (atomic against a
     * crash) and now also correct against a concurrent writer on the same
     * row (the two properties are independent; this fix only cost the first
     * version its CTE-JOIN indirection, not its single-statement shape).
     */
    async clearForceNonAdminForUserAndCreator(userId: UserId, username: string): Promise<number> {
        const result = await this.sql<
            Array<{ id: number; token_hash: string; fully_restored: boolean }>
        >`
      UPDATE service_tokens
      SET force_non_admin_narrowed_by_target =
              force_non_admin_narrowed_by_target AND (act_as_user IS DISTINCT FROM ${userId}),
          force_non_admin_narrowed_by_creator =
              force_non_admin_narrowed_by_creator
              AND (owner_user_id IS DISTINCT FROM ${userId}::uuid),
          force_non_admin = CASE
              WHEN (force_non_admin_narrowed_by_target AND (act_as_user IS DISTINCT FROM ${userId}))
                OR (force_non_admin_narrowed_by_creator
                    AND (owner_user_id IS DISTINCT FROM ${userId}::uuid))
              THEN force_non_admin
              ELSE false
          END,
          force_non_admin_narrowed_at = CASE
              WHEN (force_non_admin_narrowed_by_target AND (act_as_user IS DISTINCT FROM ${userId}))
                OR (force_non_admin_narrowed_by_creator
                    AND (owner_user_id IS DISTINCT FROM ${userId}::uuid))
              THEN force_non_admin_narrowed_at
              ELSE NULL
          END
      WHERE (
              (act_as_user = ${userId} AND force_non_admin_narrowed_by_target)
              OR (owner_user_id = ${userId} AND force_non_admin_narrowed_by_creator)
            )
        AND force_non_admin = true
        AND force_non_admin_narrowed_at IS NOT NULL
      RETURNING id, token_hash,
                (NOT force_non_admin_narrowed_by_target AND NOT force_non_admin_narrowed_by_creator)
                    AS fully_restored
    `;

        const restored = result.filter((t) => t.fully_restored);
        for (const t of restored) {
            this.tokenCache.delete(t.token_hash);
            publishAuthCacheInvalidation({ kind: 'token-narrowed', tokenHash: t.token_hash });
        }

        if (restored.length > 0) {
            logger.info(
                'Admin-scoped service tokens un-narrowed (force_non_admin cleared) for user',
                { userId, username, count: restored.length },
            );
        }

        return restored.length;
    }

    /**
     * Write a Valkey marker that this token hash has been revoked.
     * Other replicas read the marker on cache-hit and evict their LRU.
     * TTL = LRU TTL: once the LRU entry would have expired anyway, the
     * marker is no longer useful.
     */
    private async publishValkeyRevocation(tokenHash: string): Promise<void> {
        try {
            const { cacheSet, isCoordinationValkeyReady, connectValkey } =
                await import('$lib/server/cache/valkey.js');
            if (!isCoordinationValkeyReady()) await connectValkey();
            // Best-effort — if Valkey is down, fall back to per-replica TTL.
            await cacheSet(
                REVOCATION_KEY_PREFIX + tokenHash,
                '1',
                Math.ceil(TOKEN_CACHE_TTL_MS / 1000),
            );
        } catch (err) {
            logger.warn(
                'Service token revocation broadcast failed; relying on per-replica LRU TTL',
                { error: String(err) },
            );
        }
    }

    /**
     * Check whether a token hash has been broadcast as revoked from another
     * replica: `'revoked'` when the marker exists, `'clean'` when Valkey
     * answered that it does not, `'unknown'` when Valkey could not be asked
     * (not connected, or the GET threw). The cache-hit path treats `'unknown'`
     * as "confirm against the row" rather than trusting the LRU, without
     * failing closed and locking out every service token.
     */
    private async checkValkeyRevocation(
        tokenHash: string,
    ): Promise<'revoked' | 'clean' | 'unknown'> {
        try {
            const { cacheGetOrThrow, isCoordinationValkeyReady } =
                await import('$lib/server/cache/valkey.js');
            if (!isCoordinationValkeyReady()) return 'unknown';
            // cacheGetOrThrow, not cacheGet: cacheGet turns a failed GET into
            // null, which read as 'clean' during a real outage.
            const marker = await cacheGetOrThrow(REVOCATION_KEY_PREFIX + tokenHash);
            return marker !== null ? 'revoked' : 'clean';
        } catch (err) {
            warnRevocationMarkerUnavailable(err);
            return 'unknown';
        }
    }

    /**
     * Whether the row behind a cached token is still unrevoked and unexpired.
     * Consulted only when the cross-replica marker is unavailable. A DB error
     * rejects (fail closed): the next step, the creator check, fails closed
     * on the same error anyway.
     */
    private async isRowLive(tokenHash: string): Promise<boolean> {
        try {
            const rows = await this.sql<{ id: number }[]>`
      SELECT id FROM service_tokens
      WHERE token_hash = ${tokenHash}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
    `;
            return rows.length > 0;
        } catch (err) {
            // Fail closed: this runs only when the revocation marker could not
            // be read, and a service token carries admin authority.
            logger.warn(
                'Service token liveness check failed; rejecting until it can be confirmed',
                {
                    error: String(err),
                },
            );
            if (isDependencyError(err)) throw new AuthDependencyUnavailableError(err);
            return false;
        }
    }

    /**
     * Check if a token string looks like a service token
     */
    static isServiceToken(token: string): boolean {
        return token.startsWith(SVC_PREFIX);
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
        const result = await this.sql<ServiceTokenIdRow[]>`
      DELETE FROM service_tokens
      WHERE
        (expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '7 days')
        OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '1 day')
      RETURNING id
    `;

        if (result.length > 0) {
            logger.info('Cleaned up old service tokens', {
                count: result.length,
            });
        }

        return result.length;
    }
}

// Singleton instance
let instance: ServiceTokenService | null = null;

export function getServiceTokenService(): ServiceTokenService {
    if (!instance) {
        instance = new ServiceTokenService();
    }
    return instance;
}
