// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Database Connection
// PostgreSQL database for application data and AI features
import postgres, { type Notice } from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { Logger } from '../utils/logger';
import { batchResolveMediaIds as batchResolveMediaIdsHelper } from './queries/media-queries.js';
import { CatalogService } from '../services/catalog.service.js';
import { getPrimaryExternalIdProvider } from '../utils/provider-config.js';
import {
    UserProfileService,
    type UserProfileDatabaseDeps,
} from '../services/user-profile.service.js';
import { isAvailableExpr, canRequestExpr } from './queries/availability.queries.js';
import { UserRatingsService } from '../services/user-ratings.service.js';
import { EmbeddingOperationsService } from '../services/embedding-operations.service.js';
import { getIncludeWatchHistoryPreference as getIncludeWatchHistoryPreferenceQuery } from './queries/user-profile-prefs.queries.js';

const logger = Logger.for('Database');

// parseEmbeddingVector is imported from embedding-utils.ts

// Use process.env directly — works in both SvelteKit runtime and standalone scripts.
// In adapter-node, $env/dynamic/private just proxies process.env anyway, and using
// a top-level await to import it causes circular dependency deadlocks with Rolldown (Vite 8).
const DATABASE_URL: string = process.env.DATABASE_URL || '';
const isDev: boolean = process.env.NODE_ENV !== 'production';

/**
 * IMPORTANT: External IDs are NOT unique across media types!
 * The same provider ID can refer to both a movie AND a TV show.
 * Always use composite keys (provider_id + media_type).
 *
 * Example: TMDB ID 119051 is both "Wednesday" (TV) and "Wednesday" (movie)
 * Example: TMDB ID 1429 is both "25th Hour" (movie) and "Attack on Titan" (TV)
 *
 * All database operations on user_ratings, playlist_items, user_suggestions,
 * and the UUID-based media_items + external_ids tables use media_id (UUID) internally
 * with composite keys (provider_id + media_type) for external references.
 *
 * USE THE TYPE-SAFE UTILITIES:
 * - ExternalIdMap<T>: Type-safe Map that enforces composite keys
 * - ExternalIdSet: Type-safe Set that enforces composite keys
 * - createExternalIdKey(): Create composite key strings
 * - buildExternalIdMap(): Build map from provider items
 * - buildExternalIdSet(): Build set from database results
 *
 * Import from: '$lib/server/database' or '$lib/server/utils/tmdb-composite-key'
 */

// Re-export external ID utilities
// Prefer importing from '$lib/server/utils/tmdb-composite-key'
export {
    createExternalIdKey,
    parseExternalIdKey,
    buildExternalIdMap,
    buildExternalIdSet,
    ExternalIdMap,
    ExternalIdSet,
    // Deprecated aliases kept for test compatibility
    tmdbKey,
    parseTmdbKey,
} from '../utils/tmdb-composite-key.js';

export type {
    ExternalIdKey,
    ExternalIdMediaType,
    ExternalIdKeyComponents,
    TmdbMediaType,
} from '../utils/tmdb-composite-key.js';

export interface TmdbMediaKey {
    tmdb_id: number;
    /**
     * Widened from 'movie' | 'tv': getUserSuggestions joins media_items with no
     * media_type filter, so this reflects whatever the suggestion points at.
     */
    media_type: 'movie' | 'tv' | 'episode' | 'season';
}

// Three separate pools share one Postgres backend. Splitting them isolates
// distinct workloads so connection exhaustion in one cannot starve another:
//   - getDb()          → web pool       (max=8) — HTTP route handlers, hooks,
//                                                 middleware (incl. the playback
//                                                 hot path: HLS/probe/auth)
//   - getTaskDb()      → task pool      (max=7) — orchestrator, runner, plugin
//                                                 ctx.sql, native builtin tasks,
//                                                 file scanner
//   - getAdminDb()     → admin pool     (max=4) — admin DASHBOARD reads (status,
//                                                 cluster, attention, heavy stats).
//                                                 Polled on a 60s bell + every
//                                                 open admin tab; isolating it
//                                                 means admin polling can never
//                                                 queue video starts behind it on
//                                                 the web pool.
//   - getHeartbeatDb() → heartbeat pool (max=2) — task runner liveness heartbeat
//                                                 only; isolated so a full task
//                                                 pool can't starve the beat.
// 8 + 7 + 4 + 2 = 21 total, well under Postgres' default max_connections (100).
let dbSql: postgres.Sql | null = null;
let taskDbSql: postgres.Sql | null = null;
let adminDbSql: postgres.Sql | null = null;
let heartbeatDbSql: postgres.Sql | null = null;
// closeDb is terminal for this process/module lifetime. Late shutdown callbacks
// must not replace a pool whose sockets are still being closed.
let terminalCloseStarted = false;
let closePending: Promise<void> | undefined;

// Per-pool connection caps. Defaults sum to 19, well under Postgres' default
// max_connections=100. Override per deployment via env — e.g. a dedicated worker
// container (no web traffic, idle web/admin pools) can raise
// LUMASTRA_DB_POOL_TASK_MAX to reclaim the capacity the split would otherwise cap
// at 7. Read from process.env directly (not config.ts) to match this module's
// no-config-import constraint — see DATABASE_URL note above.
const WEB_POOL_MAX = Number(process.env.LUMASTRA_DB_POOL_WEB_MAX) || 8;
const TASK_POOL_MAX = Number(process.env.LUMASTRA_DB_POOL_TASK_MAX) || 7;
const ADMIN_POOL_MAX = Number(process.env.LUMASTRA_DB_POOL_ADMIN_MAX) || 4;
// Tiny dedicated pool for the task runner's liveness heartbeat (one small
// `UPDATE task_history SET heartbeat_at = NOW()` per active run, ~every 30s).
// Isolated from the task pool so a long scan that checks out all TASK_POOL_MAX
// connections can't starve the heartbeat — under host I/O load that starvation
// surfaced as `write CONNECT_TIMEOUT` heartbeat failures, which (together with a
// stalled BullMQ lock) wedged long-running scans. Kept warm (long idle timeout)
// so each beat reuses an open connection instead of paying a TCP+auth handshake
// that can itself time out under load.
const HEARTBEAT_POOL_MAX = Number(process.env.LUMASTRA_DB_POOL_HEARTBEAT_MAX) || 2;

/**
 * The resolved per-instance connection-pool caps (after env overrides), exported
 * as the single source of truth for any code that needs to reason about the
 * connection budget — e.g. the connection-budget sanity check that compares the
 * sum of pools (× replica count) against Postgres `max_connections`. Defined here
 * rather than re-read from env elsewhere so the default fallbacks live in exactly
 * one place.
 */
export const DB_POOL_MAX = {
    web: WEB_POOL_MAX,
    task: TASK_POOL_MAX,
    admin: ADMIN_POOL_MAX,
    heartbeat: HEARTBEAT_POOL_MAX,
} as const;

/** Total connections one instance can open across all pools. */
export const DB_POOL_TOTAL_PER_INSTANCE =
    WEB_POOL_MAX + TASK_POOL_MAX + ADMIN_POOL_MAX + HEARTBEAT_POOL_MAX;

// Parse BIGINT (OID 20) as JavaScript number instead of string.
// Safe because no column exceeds Number.MAX_SAFE_INTEGER (9007199254740991).
const bigintAsNumber = {
    to: 20,
    from: [20],
    parse: (x: string) => Number(x),
    serialize: (x: number) => x.toString(),
};

/**
 * Build a postgres.js pool with the project's shared connection options.
 * The ONLY thing that differs between the web and task pools is `max` — every
 * per-connection setting (timezone, bigint parsing, statement_timeout, idle/
 * connect timeouts, notice handling) is identical so both pools behave the same.
 */
function connectPool(
    max: number,
    label: string,
    opts?: { idleTimeoutSecs?: number },
): postgres.Sql {
    const sanitizedUrl = DATABASE_URL.replace(/:[^:]*@/, ':****@');
    const timezone = process.env.TZ || 'UTC';
    const idleTimeout = opts?.idleTimeoutSecs ?? 20;
    logger.info('Connecting to database', {
        url: sanitizedUrl,
        pool: label,
        max,
        timezone,
    });

    const sql = postgres(DATABASE_URL, {
        max,
        idle_timeout: idleTimeout,
        connect_timeout: 10,
        onnotice: isDev ? (msg: Notice) => logger.debug('PostgreSQL notice', { msg }) : () => {}, // Only log in dev
        types: { bigint: bigintAsNumber },
        // Set timezone + a default statement_timeout for all connections.
        // The timeout (5 min) bounds how long any single query can pin a
        // pooled connection, so a wedged plugin/task query can't hold one for
        // the full ~10-min stall-fail window. On the task pool this is the
        // primary defence (alongside the per-advisory-lock lock_timeout); the
        // web pool keeps it too as a harmless query ceiling.
        // Migrations / known-heavy ops set their own `SET LOCAL
        // statement_timeout`, which overrides this within their txn; a fired
        // timeout surfaces as SQLSTATE 57014, already classified transient +
        // retried (see transient-pg.ts).
        //
        // idle_in_transaction_session_timeout (30 s) closes the lock-holding
        // gap that statement_timeout alone can't cover: a connection that has
        // opened a transaction but is idle (no active query) holds row/table
        // locks and a pool slot indefinitely without this setting. A stalled
        // plugin, a crashed client, or a BEGIN with no matching COMMIT would
        // block other waiters until the idle connection was eventually reaped
        // by idle_timeout — which at 20 s only fires outside a transaction.
        // 30 s matches statement_timeout at the lower end; Postgres surfaces
        // the breach as SQLSTATE 25P03, classified transient in transient-pg.ts.
        connection: {
            TimeZone: timezone,
            statement_timeout: 300000,
            idle_in_transaction_session_timeout: 30000,
        },
    }) as unknown as postgres.Sql;

    // Verify timezone is set correctly
    sql<{ tz: string; current_time: string }[]>`
        SELECT current_setting('TIMEZONE') as tz, NOW() as current_time
    `
        .then((result) => {
            logger.info('Connected with timezone', {
                pool: label,
                timezone: result[0].tz,
                currentTime: result[0].current_time,
            });
        })
        .catch((err) => {
            logger.warn('Failed to verify timezone', err as Error);
        });

    return sql;
}

/**
 * Web pool — serves user-facing HTTP routes. Isolated from the task pool
 * (getTaskDb) so background task/plugin connection exhaustion cannot starve
 * web requests. Graceful fallback returns null when DATABASE_URL is unset.
 */
export function getDb(): postgres.Sql | null {
    if (terminalCloseStarted) return null;
    try {
        if (!DATABASE_URL) {
            logger.warn('DATABASE_URL not configured - database features will be disabled');
            return null;
        }

        if (!dbSql) {
            dbSql = connectPool(WEB_POOL_MAX, 'web');
        }
        return dbSql;
    } catch (error) {
        logger.warn('Database connection failed', error as Error);
        return null;
    }
}

/**
 * Task/plugin pool — serves the background task system (orchestrator, runner,
 * plugin execution context / ctx.sql, native builtin tasks, file scanner).
 * Isolated from the web pool so connection exhaustion in task code cannot
 * starve user-facing routes.
 *
 * DO NOT import this from a web route — web-tier code must use getDb(). See the
 * pool-split audit; the runner threads this handle into every task's ctx.sql.
 */
export function getTaskDb(): postgres.Sql | null {
    if (terminalCloseStarted) return null;
    try {
        if (!DATABASE_URL) {
            logger.warn('DATABASE_URL not configured - task database features will be disabled');
            return null;
        }

        if (!taskDbSql) {
            taskDbSql = connectPool(TASK_POOL_MAX, 'task');
        }
        return taskDbSql;
    } catch (error) {
        logger.warn('Task database connection failed', error as Error);
        return null;
    }
}

/**
 * Heartbeat pool — a tiny, dedicated pool used ONLY by the task runner's
 * liveness heartbeat (`UPDATE task_history SET heartbeat_at = NOW()`). Isolated
 * from getTaskDb() so a task that checks out the whole task pool (e.g. a large
 * file-library-scan) cannot starve the heartbeat write. Kept warm with a long
 * idle timeout so each ~30s beat reuses an open connection instead of opening a
 * fresh one (the TCP+auth handshake is exactly what timed out under host load).
 *
 * Use this ONLY for the heartbeat write. Everything else (plugin ctx.sql,
 * terminal writes, queries) stays on getTaskDb().
 */
export function getHeartbeatDb(): postgres.Sql | null {
    if (terminalCloseStarted) return null;
    try {
        if (!DATABASE_URL) {
            return null;
        }

        if (!heartbeatDbSql) {
            // 300s idle timeout >> the 30s beat cadence, so the connection stays
            // warm between beats; it only recycles after a run ends and the pool
            // goes fully idle for 5 min.
            heartbeatDbSql = connectPool(HEARTBEAT_POOL_MAX, 'heartbeat', {
                idleTimeoutSecs: 300,
            });
        }
        return heartbeatDbSql;
    } catch (error) {
        logger.warn('Heartbeat database connection failed', error as Error);
        return null;
    }
}

/**
 * Admin pool — serves admin DASHBOARD READ endpoints (status, cluster,
 * attention, and the heavy stats queries behind them). These are polled by the
 * global attention bell (every 60s) and by every open admin tab, so before this
 * split they shared the web pool with the playback hot path and could queue
 * video starts behind a burst of dashboard polls. Isolating them here means
 * admin polling can never contend with HLS/probe/auth on the web pool.
 *
 * Use this ONLY for admin dashboard READS. Do NOT use it for mutation endpoints,
 * config writes, or anything on the playback/web hot path — those stay on getDb().
 * Like getTaskDb, this must not be imported by general web routes.
 */
export function getAdminDb(): postgres.Sql | null {
    if (terminalCloseStarted) return null;
    try {
        if (!DATABASE_URL) {
            logger.warn('DATABASE_URL not configured - admin database features will be disabled');
            return null;
        }

        if (!adminDbSql) {
            adminDbSql = connectPool(ADMIN_POOL_MAX, 'admin');
        }
        return adminDbSql;
    } catch (error) {
        logger.warn('Admin database connection failed', error as Error);
        return null;
    }
}

/**
 * Test AI database connectivity
 */
export async function testDbConnection(): Promise<boolean> {
    try {
        const sql = getDb();
        if (!sql) {
            logger.warn('Database connection is null');
            return false;
        }

        await sql`SELECT 1`;
        return true;
    } catch (error) {
        logger.warn('Health check failed', error as Error);
        return false;
    }
}

/**
 * Terminally close this process's owned database pools. Failed acknowledgements
 * retain ownership for a later explicit retry; getters remain closed throughout.
 */
export function closeDb(): Promise<void> {
    terminalCloseStarted = true;
    closePending ??= closeOwnedPools().finally(() => {
        closePending = undefined;
    });
    return closePending;
}

async function closeOwnedPools(): Promise<void> {
    const owned: Array<{ pool: postgres.Sql | null; clear: () => void }> = [
        {
            pool: dbSql,
            clear: () => {
                dbSql = null;
            },
        },
        {
            pool: taskDbSql,
            clear: () => {
                taskDbSql = null;
            },
        },
        {
            pool: adminDbSql,
            clear: () => {
                adminDbSql = null;
            },
        },
        {
            pool: heartbeatDbSql,
            clear: () => {
                heartbeatDbSql = null;
            },
        },
    ];
    const results = await Promise.allSettled(
        owned.map(async ({ pool, clear }) => {
            if (!pool) return;
            // Force-close after 3 s: a server that is already gone (compose restart) never
            // acknowledges, and pool.end() would otherwise wait for it indefinitely.
            await pool.end({ timeout: 3 });
            clear();
        }),
    );
    const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (failures.length)
        throw new AggregateError(failures, 'UNKNOWN: database pool closure is incomplete');
}

// Types for AI database operations
export interface MediaEmbedding {
    id: number;
    internal_id?: string;
    tmdb_id: number | null;
    primary_ext_id?: number | null; // Provider-agnostic alias for tmdb_id (numeric, for image proxy URLs)
    imdb_id?: string; // IMDB identifier (tt1234567 format)
    media_type: 'movie' | 'tv';
    title: string;
    original_title?: string;
    english_title?: string;
    overview?: string;
    genres: number[];
    release_date?: string;
    release_year?: number;
    vote_average?: number;
    vote_count?: number;
    popularity?: number;
    runtime_minutes?: number;
    budget?: number;
    revenue?: number;

    // Cast and crew
    actors?: string[];
    directors?: string[];
    producers?: string[];
    writers?: string[];

    // Classifications
    keywords?: string[];
    networks?: string[];
    production_companies?: string[];
    spoken_languages?: string[];
    production_countries?: string[];
    certification?: string;

    // Ratings
    embedding?: number[]; // Will be JSONB array
    library_embedding?: number[] | string; // Library embedding
    discovery_embedding?: number[] | string; // Discovery embedding
    imdb_rating?: number; // IMDB rating
    rt_rating?: number; // Rotten Tomatoes rating
    tmdb_rating?: number; // TMDB rating (vote_average)

    // MDBList enrichment data
    mdblist_score?: number;
    mdblist_keywords?: string[];
    letterboxd_rating?: number;
    letterboxd_votes?: number;
    metacritic_score?: number;
    rt_audience_score?: number;
    trakt_score?: number;
    mal_score?: number;
    mal_votes?: number;
    streaming_services?: string[];
    anime_genres?: string[];
    mdblist_last_updated?: Date;

    // Availability
    is_available?: boolean;
    can_request?: boolean;
    jellyfin_id?: string;
    jellyseerr_id?: number;

    // Jellyfin library info (for filtering/browsing)
    jellyfin_library_id?: string;
    jellyfin_library_name?: string;

    // Local-only flag (uses virtual TMDB ID)
    is_local_only?: boolean;

    // Media assets
    poster_path?: string;
    backdrop_path?: string;
    trailer_url?: string;

    metadata?: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
}

export interface UserProfile {
    user_id: string;
    catalog_embedding?: number[] | null;
    request_embedding?: number[] | null;
    availability_preference?: number | null;
    quality_weight?: number | null;
    popularity_weight?: number | null;
    recency_weight?: number | null;
    preferences: Record<string, unknown>;
    total_ratings: number;
    last_activity: Date;
    created_at: Date;
    updated_at: Date;
}

export interface UserRating {
    id: number;
    user_id: string;
    /** Internal UUID from media_items.id — the primary key */
    media_id: string;
    /** Display-only: primary external ID (TMDB, TVDB, etc.) as a string */
    primary_ext_id?: string;
    /** Which provider primary_ext_id came from */
    primary_provider?: string;
    media_type: 'movie' | 'tv';
    rating: number; // 1-10 (updated from 1-5)
    suggestion_context?: string;
    skipped?: boolean;
    created_at: Date;
}

/** @deprecated UserRating now includes media_id — use UserRating directly */
export type UserRatingWithUuid = UserRating;

export interface UserSuggestion {
    id: number;
    user_id: string;
    media_id: string;
    primary_ext_id?: string;
    media_type: 'movie' | 'tv';
    cache_context?: string;
    requested_media_type?: 'movie' | 'tv';
    library_similarity_score?: number | null;
    discovery_similarity_score?: number | null;
    quality_score?: number | null;
    popularity_score?: number | null;
    combined_score: number;
    suggestion_reason?: string;
    is_available: boolean;
    can_request: boolean;
    created_at: Date;
    expires_at: Date;
}

// Database operations
export class Database {
    private sql: postgres.Sql;
    private _userProfileService: UserProfileService | null = null;
    private _userRatingsService: UserRatingsService | null = null;
    private _catalogService: CatalogService | null = null;
    private _embeddingOperationsService: EmbeddingOperationsService | null = null;

    /**
     * @param providedSql Optional pool handle. Task-context callers pass the
     * task pool (`ctx.sql` / `getTaskDb()`) so their bulk work doesn't draw
     * from the web pool; omit it and the constructor resolves `getDb()` (web
     * pool), preserving behaviour for the ~25 web/auth/startup call sites.
     * Pass a POOL handle only — never a transaction (this.sql is long-lived).
     */
    constructor(providedSql?: postgres.Sql | null) {
        const connection = providedSql ?? getDb();
        if (!connection) {
            throw Object.assign(new Error('AI Database connection failed'), {
                code: 'CONNECTION_CLOSED',
            });
        }
        this.sql = connection;
    }

    /**
     * Get CatalogService instance (lazy initialization)
     */
    private get catalogService(): CatalogService {
        if (!this._catalogService) {
            this._catalogService = new CatalogService(this.sql);
        }
        return this._catalogService;
    }

    /**
     * Get EmbeddingOperationsService instance (lazy initialization)
     * @internal - For testing purposes and internal use
     */
    public get embeddingOperationsService(): EmbeddingOperationsService {
        if (!this._embeddingOperationsService) {
            this._embeddingOperationsService = new EmbeddingOperationsService(this.sql);
        }
        return this._embeddingOperationsService;
    }

    /**
     * Get UserProfileService instance (lazy initialization)
     * Uses dependency injection pattern to provide required database methods
     */
    private get userProfileService(): UserProfileService {
        if (!this._userProfileService) {
            const deps: UserProfileDatabaseDeps = {
                getMediaEmbedding: (tmdbId, mediaType) => this.getMediaEmbedding(tmdbId, mediaType),
                getMediaEmbeddingByUuid: (mediaId) => this.getMediaEmbeddingByUuid(mediaId),
                getUserRatingsWithUuid: (userId, limit, includeSkipped) =>
                    this.getUserRatingsWithUuid(userId, limit, includeSkipped),
                batchResolveMediaIds: (items) => batchResolveMediaIdsHelper(this.sql, items),
                batchBuildMediaEmbeddingsFromUuids: (mediaIds) =>
                    this.embeddingOperationsService.batchBuildMediaEmbeddingsFromUuids(mediaIds),
                getIncludeWatchHistoryPreference: (userId) =>
                    this.getIncludeWatchHistoryPreference(userId),
            };
            this._userProfileService = new UserProfileService(this.sql, deps);
        }
        return this._userProfileService;
    }

    /**
     * Get UserRatingsService instance (lazy initialization)
     */
    private get userRatingsService(): UserRatingsService {
        if (!this._userRatingsService) {
            this._userRatingsService = new UserRatingsService(this.sql);
        }
        return this._userRatingsService;
    }

    /**
     * Get the underlying SQL client for advanced operations
     */
    get sqlClient(): postgres.Sql {
        return this.sql;
    }

    /**
     * Get SQL client - alias for compatibility
     */
    getSql(): postgres.Sql {
        return this.sql;
    }

    // =========================================================================
    // UUID-BASED CATALOG HELPERS (Bridge for TMDB → UUID migration)
    // =========================================================================

    // =========================================================================
    // UUID-BASED HELPER METHODS
    // =========================================================================

    /**
     * Check if user has watched a media item.
     * Uses the UUID-based user_media_state table.
     *
     * @param userId - User identifier
     * @param mediaId - Internal UUID of the media item
     * @returns true if the user has watched the item, false otherwise
     */

    /**
     * Batch get media embeddings by UUIDs.
     * Public wrapper for batchBuildMediaEmbeddingsFromUuids.
     */
    async getMediaEmbeddingsByUuids(mediaIds: string[]): Promise<Map<string, MediaEmbedding>> {
        return this.embeddingOperationsService.batchBuildMediaEmbeddingsFromUuids(mediaIds);
    }

    /**
     * Public alias matching `UserProfileDatabaseDeps.batchBuildMediaEmbeddingsFromUuids`.
     * Required because `database.service.ts` casts `Database` directly to that
     * interface; without this method the cast lies and `getUserProfileService()`
     * blows up at runtime when the service tries to fetch embeddings.
     */
    async batchBuildMediaEmbeddingsFromUuids(
        mediaIds: string[],
    ): Promise<Map<string, MediaEmbedding>> {
        return this.embeddingOperationsService.batchBuildMediaEmbeddingsFromUuids(mediaIds);
    }

    /**
     * Public alias matching `UserProfileDatabaseDeps.batchResolveMediaIds`.
     * Same reason as above — the deps cast in `database.service.ts` requires
     * this method to exist on the class itself, not just inline inside the
     * lazy `userProfileService` getter.
     */
    async batchResolveMediaIds(
        items: Array<{ tmdbId: number; mediaType: 'movie' | 'tv' }>,
    ): Promise<Map<string, string>> {
        return batchResolveMediaIdsHelper(this.sql, items);
    }

    /**
     * Public alias matching `UserProfileDatabaseDeps.getIncludeWatchHistoryPreference`.
     * Same reason as the aliases above — `database.service.ts` casts `Database`
     * directly to that interface, so this must exist on the class itself.
     */
    async getIncludeWatchHistoryPreference(userId: UserId): Promise<boolean> {
        return getIncludeWatchHistoryPreferenceQuery(this.sql, userId);
    }

    /**
     * Get media embedding by TMDB ID and media type.
     *
     * IMPORTANT: mediaType is REQUIRED because TMDB IDs are NOT unique across types!
     * Example: TMDB ID 1429 = "25th Hour" (movie) AND "Attack on Titan" (tv)
     *
     * Never call this with just tmdbId - always provide mediaType to avoid
     * returning the wrong media's data (wrong poster, wrong title, etc.)
     */
    async getMediaEmbedding(
        tmdbId: number,
        mediaType: 'movie' | 'tv',
    ): Promise<MediaEmbedding | null> {
        const { resolveTmdbToUuid } = await import('./queries/media-lookup.queries.js');
        // Resolve TMDB ID to UUID
        const mediaId = await resolveTmdbToUuid(this.sql, tmdbId, mediaType);
        if (!mediaId) return null;

        // Build MediaEmbedding from new tables
        return this.embeddingOperationsService.buildMediaEmbeddingFromUuid(mediaId);
    }

    /**
     * Get media embedding directly by internal UUID.
     * Use this when you already have the UUID (e.g., from getUserRatingsWithUuid)
     * to avoid redundant TMDB ID → UUID resolution.
     */
    async getMediaEmbeddingByUuid(mediaId: string): Promise<MediaEmbedding | null> {
        return this.embeddingOperationsService.buildMediaEmbeddingFromUuid(mediaId);
    }

    /**
     * Batch fetch media embeddings by composite keys (tmdb_id + media_type).
     * This is the safe version that handles TMDB ID collisions correctly.
     *
     * @param keys - Array of {tmdb_id, media_type} objects
     * @returns Only the exact media items requested
     */
    async getMediaEmbeddingsByKeys(keys: TmdbMediaKey[]): Promise<MediaEmbedding[]> {
        if (keys.length === 0) return [];

        // Batch resolve TMDB IDs to UUIDs
        const resolved = await batchResolveMediaIdsHelper(
            this.sql,
            keys.map((k) => ({ tmdbId: k.tmdb_id, mediaType: k.media_type })),
        );

        // Collect all resolved UUIDs
        const uuids = Array.from(resolved.values());
        if (uuids.length === 0) return [];

        // Batch fetch all embeddings (5 bulk queries instead of N*5)
        const embeddingsMap =
            await this.embeddingOperationsService.batchBuildMediaEmbeddingsFromUuids(uuids);

        // Return in original key order, preserving only found items
        const results: MediaEmbedding[] = [];
        for (const key of keys) {
            const lookupKey = `${key.tmdb_id}:${key.media_type}`;
            const mediaId = resolved.get(lookupKey);
            if (mediaId) {
                const embedding = embeddingsMap.get(mediaId);
                if (embedding) results.push(embedding);
            }
        }
        return results;
    }

    // User profile operations (delegated to UserProfileService)
    /**
     * @deprecated Use UserProfileService.getUserProfile() instead
     */
    async getUserProfile(userId: UserId): Promise<UserProfile | null> {
        return this.userProfileService.getUserProfile(userId);
    }

    /**
     * @deprecated Use UserProfileService.upsertUserProfile() instead
     */
    async upsertUserProfile(
        profile: Omit<UserProfile, 'created_at' | 'updated_at'>,
    ): Promise<UserProfile> {
        return this.userProfileService.upsertUserProfile(profile);
    }

    /**
     * Create hybrid user profile combining watch history and ratings with enhanced weighting
     * @deprecated Use UserProfileService.createEnhancedUserProfile() instead
     */
    async createEnhancedUserProfile(
        userId: UserId,
        watchHistory: Array<{
            primary_id?: string;
            title: string;
            genres?: string[];
            overview?: string;
            playCount?: number;
            playbackPositionTicks?: number;
            runtimeTicks?: number;
            mediaType?: 'movie' | 'tv';
            episodesWatched?: number;
            totalEpisodes?: number;
        }> = [],
        existingRatings?: UserRatingWithUuid[],
        softDemote?: { mediaIds: Set<string>; multiplier: number },
    ): Promise<UserProfile | null> {
        return this.userProfileService.createEnhancedUserProfile(
            userId,
            watchHistory,
            existingRatings,
            softDemote,
        );
    }

    // Rating operations (delegated to UserRatingsService)

    /**
     * @deprecated Use UserRatingsService.getUserRatings() instead
     */
    async getUserRatings(
        userId: UserId,
        limit = 100,
        includeSkipped = false,
    ): Promise<UserRating[]> {
        return this.userRatingsService.getUserRatings(userId, limit, includeSkipped);
    }

    /**
     * Get user ratings WITH internal UUID - for internal callers that need to
     * call buildMediaEmbeddingFromUuid without re-resolving TMDB ID → UUID.
     *
     * Use this instead of getUserRatings() when you immediately need to fetch
     * embeddings for the rated items.
     * @deprecated Use UserRatingsService.getUserRatingsWithUuid() instead
     */
    async getUserRatingsWithUuid(
        userId: UserId,
        limit = 100,
        includeSkipped = false,
    ): Promise<UserRatingWithUuid[]> {
        return this.userRatingsService.getUserRatingsWithUuid(userId, limit, includeSkipped);
    }

    /**
     * Get cached user suggestions with context-aware filtering.
     * @param userId - User identifier
     * @param limit - Maximum number of suggestions to return
     * @param options - Filtering options for cache context and media type
     * @returns Promise<UserSuggestion[]> Array of cached user suggestions
     */
    async getUserSuggestions(
        userId: UserId,
        limit = 20,
        options: {
            cacheContext?: string;
            mediaType?: 'movie' | 'tv';
            watchedBased?: boolean;
            withoutRatingInfluence?: boolean;
        } = {},
    ): Promise<UserSuggestion[]> {
        const { cacheContext, mediaType, watchedBased, withoutRatingInfluence } = options;

        let contextKey = cacheContext || 'general';
        if (watchedBased) contextKey = 'watched_based';
        if (withoutRatingInfluence) contextKey = 'no_rating_influence';

        // Query user_suggestions with media_items for media_type (authoritative)
        // Uses scalar subquery for TMDB ID to avoid duplicate rows from external_ids
        const baseQuery = mediaType
            ? this.sql`
                SELECT
                    us.id, us.user_id, us.cache_context,
                    us.library_similarity_score, us.discovery_similarity_score,
                    us.combined_score, us.explanation as suggestion_reason,
                    us.created_at, us.expires_at,
                    us.media_id,
                    (SELECT external_id FROM external_ids WHERE media_id = us.media_id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) as primary_ext_id,
                    mi.media_type,
                    ${isAvailableExpr(this.sql, this.sql`us.media_id`)} AS is_available,
                    ${canRequestExpr(this.sql, this.sql`us.media_id`)} AS can_request
                FROM user_suggestions us
                JOIN media_items mi ON mi.id = us.media_id
                WHERE us.user_id = ${userId}
                  AND us.expires_at > NOW()
                  AND us.cache_context = ${contextKey}
                  AND mi.media_type = ${mediaType}
                ORDER BY us.combined_score DESC, us.created_at DESC
                LIMIT ${limit}
            `
            : this.sql`
                SELECT
                    us.id, us.user_id, us.cache_context,
                    us.library_similarity_score, us.discovery_similarity_score,
                    us.combined_score, us.explanation as suggestion_reason,
                    us.created_at, us.expires_at,
                    us.media_id,
                    (SELECT external_id FROM external_ids WHERE media_id = us.media_id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) as primary_ext_id,
                    mi.media_type,
                    ${isAvailableExpr(this.sql, this.sql`us.media_id`)} AS is_available,
                    ${canRequestExpr(this.sql, this.sql`us.media_id`)} AS can_request
                FROM user_suggestions us
                JOIN media_items mi ON mi.id = us.media_id
                WHERE us.user_id = ${userId}
                  AND us.expires_at > NOW()
                  AND us.cache_context = ${contextKey}
                ORDER BY us.combined_score DESC, us.created_at DESC
                LIMIT ${limit}
            `;

        const results = await baseQuery;
        return results.map((r: Record<string, unknown>) => ({
            id: r.id as number,
            user_id: r.user_id as string,
            media_id: r.media_id as string,
            primary_ext_id: r.primary_ext_id ? String(r.primary_ext_id) : undefined,
            media_type: r.media_type as UserSuggestion['media_type'],
            cache_context: r.cache_context as string,
            library_similarity_score: r.library_similarity_score as number | undefined,
            discovery_similarity_score: r.discovery_similarity_score as number | undefined,
            combined_score: r.combined_score as number | undefined,
            suggestion_reason: r.suggestion_reason as string | undefined,
            is_available: r.is_available as boolean,
            can_request: r.can_request as boolean,
            created_at: r.created_at as Date,
            expires_at: r.expires_at as Date,
        })) as UserSuggestion[];
    }
}
