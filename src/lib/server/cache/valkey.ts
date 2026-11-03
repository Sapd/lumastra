// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Valkey client for caching using official valkey-glide
// Optimized for vector similarity caching, sessions, and general application caching

import { isMainThread } from 'node:worker_threads';
import {
    GlideClient,
    GlideClientConfiguration,
    Logger as GlideLogger,
    TimeUnit,
} from '@valkey/valkey-glide';
import type postgres from 'postgres';
import { Logger } from '../utils/logger';
import {
    assertValkeyEndpointConfiguration,
    parseValkeyEndpoint,
} from '../config/valkey-endpoints.js';

const logger = Logger.for('Cache');

/**
 * GLIDE's Rust core logs to stdout at WARN by default. At that level the only
 * routine lines are expected, self-healing events — e.g. 5x `received error …
 * NoScriptError: No matching script` at every boot, which is the EVALSHA
 * script-cache miss our Lua loaders answer with SCRIPT LOAD / EVAL. Real
 * failures (connection loss, client creation) are logged at ERROR, and our own
 * wrappers log them too. `VALKEY_GLIDE_LOG_LEVEL` (error|warn|info|debug|trace|
 * off) overrides it for debugging.
 */
const GLIDE_LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace', 'off'] as const;
type GlideLogLevel = (typeof GLIDE_LOG_LEVELS)[number];
export function resolveGlideLogLevel(raw: string | undefined): GlideLogLevel {
    const v = raw?.trim().toLowerCase();
    return (GLIDE_LOG_LEVELS as readonly string[]).includes(v ?? '')
        ? (v as GlideLogLevel)
        : 'error';
}
try {
    GlideLogger.setLoggerConfig(resolveGlideLogLevel(process.env.VALKEY_GLIDE_LOG_LEVEL));
} catch {
    // Best-effort (and absent under module mocks) — never block cache init.
}

// Use process.env directly — works in both SvelteKit runtime and standalone scripts
// (e.g. scripts/startup-migration.ts launched via tsx during container boot).
// In adapter-node, $env/dynamic/private just proxies process.env anyway, so the
// behaviour is identical at runtime while avoiding the tsx ERR_MODULE_NOT_FOUND
// crash on the $env virtual module.
const VALKEY_URL: string = process.env.CACHE_URL || '';

// Coordination never falls back to the evictable cache instance. Validation is
// deferred until connection/startup so importing pure helpers remains side-effect free.
const TASK_VALKEY_URL: string = process.env.TASK_CACHE_URL || '';
const COORD_IS_SEPARATE: boolean = TASK_VALKEY_URL !== '';

// Key prefixes whose loss can cause a double-run, stuck/orphaned run, lost
// lock/dedup, or a broken in-flight auth/session/playback flow. These MUST live
// on the noeviction coordination instance. Closed list from the call-site
// inventory (Appendix A of the design doc); everything else defaults to the
// evictable cache instance. Over-inclusion is safe (a stray cache key just uses
// a little noeviction memory); the dangerous direction — a coordination key on
// the eviction instance — is what this prevents. When adding a NEW coordination
// key, add its prefix here.
const COORDINATION_KEY_PREFIXES: readonly string[] = [
    'lock:',
    'task:',
    'circuit',
    'stage:',
    'scheduler',
    'scheduled',
    'schedule-overdue',
    'cluster:node:',
    'jfcompat:session:',
    // Losing this claim would notify the token owner again before 24 hours.
    'v1:jf:pat-deny-notice:',
    // Daily per-route counters of unknown /j (Jellyfin-compat) requests; see
    // src/lib/server/compat/jellyfin-unknown-routes.ts.
    'jfunk:',
    // Daily API response conformance counts and first samples share retention.
    'apiconf:',
    // Per-user index of the above (+ its "already backfilled" marker). Must sit
    // on the same noeviction instance as the sessions it indexes: if the index
    // were evictable, a live client could silently disappear from the user's
    // connected-clients list while its session key survived.
    'jfcompat:user-sessions',
    'jfcompat:auth_key_',
    // Quick Connect pending secret + its code→secret lookup (jfcompat:qc:secret:*,
    // jfcompat:qc:code:*) — same reasoning as jfcompat:auth_key_/oidc:tx: below:
    // a single-use, short-TTL (5 min) pending-auth handle that must not be
    // evicted mid-flow. revokeSessionsForUser()'s Quick Connect fan-out sweep
    // SCANs via getCoordinationClient() — before this entry existed, cacheSet()
    // routed these keys to the evictable cache client via pickClient(), so the
    // sweep's SCAN silently matched nothing on any deployment with a separate
    // TASK_CACHE_URL (its return value is indistinguishable from "no pending
    // secret"). Keep auth handles on the same instance as the revocation sweep.
    'jfcompat:qc:',
    // Jellyfin remote control (jfcompat:rc:v1:devices / caps / viewing / online
    // hashes). Cross-replica session state: apps report their capabilities only
    // at startup and the sweep never rebuilds a missing device row, so an
    // evicted hash would leave every open TV non-controllable until the app is
    // restarted.
    'jfcompat:rc:',
    'jfss:', // Jellyfin silent-start detector (silent-start.ts)
    // Single-use OIDC login transaction — keep on the noeviction coordination
    // instance so an in-flight login can't be evicted under memory pressure.
    'oidc:tx:',
    'rate-bucket:',
    'music-transcode:concurrent',
    'v1:playback-plan:',
    'livetv:v1:',
    // Session data lives on coordination, but existing v2 viewer locks must
    // keep their legacy routing so old/new replicas share a lock during rolls.
    'livetv:v2:psess:',
    'livetv:v2:viewer-psess:',
    // Viewer records are written directly to coordination and track live source
    // occupancy. Revocation scans must reach those same records, never the cache.
    'livetv:v2:session:',
    'sessions:v1:kicked:',
    'preview:session:',
    'preview:user-livetv:',
    'preview:livetv:',
    'playback:livetv:',
    // Per-user pending download-rendition prepares. An evicted set silently
    // LIFTS the per-user cap, letting one unattended pool monopolise the box's
    // only encode slot — the dangerous direction, so it belongs on the
    // noeviction instance.
    'dl:prep:',
    // Deployment-wide showcase transcode slots. Same reasoning as `dl:prep:`
    // one line up, one notch more dangerous: an evicted slot set does not just
    // lift a fairness cap, it lifts the ONLY hard ceiling on concurrent
    // unauthenticated ffmpeg spawns (see
    // `enterprise/showcase/hls/showcase-transcode-cap.ts`).
    'showcase:transcode:',
    // Security- and correctness-bearing state (independent review of the
    // two-Valkey split, 2026-10-20). Each of these fails OPEN if evicted:
    //   ratelimit:               auth/API rate-limit windows — eviction resets a
    //                            brute-force counter mid-attack
    //   pat-revoked:,            revocation markers checked on every token use —
    //   stream-token-revoked:,   eviction makes a revoked token valid again on
    //   svc-token-revoked:,      peers until their local cache expires
    //   device-session-revoked:
    //   plugin-auth:tx:          single-use plugin sign-in transaction
    //   directplay:              Jellyfin direct-play tokens + stream-limit slots
    //   preview:admin-disabled   operator kill switch for previews (durable)
    //   bandwidth:sessions:      per-session bandwidth accounting behind limits
    //   devcmd:                  device remote-control queues, presence and the
    //                            per-sender command rate limit
    //   watch:v2:                Watch Together live parties, members, event
    //                            sequence and replay ring — evicting a party
    //                            ends it for everyone mid-film
    'ratelimit:',
    'pat-revoked:',
    'stream-token-revoked:',
    'svc-token-revoked:',
    'device-session-revoked:',
    'plugin-auth:tx:',
    'directplay:',
    'preview:admin-disabled',
    'bandwidth:sessions:',
    'devcmd:',
    'watch:v2:',
    // Live TV FFmpeg failure forensics: the stream proxy RPUSHes, the worker
    // drains into Postgres. The proxy writes to TASK_CACHE_URL, so the drain
    // must read the same instance (an evicted list also loses the evidence).
    'livetv:failures:',
    // Settled from the classification guard (valkey-key-classification.test.ts):
    //   mal:oauth:, trakt:oauth:  single-use state of the MAL/Trakt link flows
    //                             (same case as oidc:tx: — eviction breaks the flow)
    //   assistant-confirm:        the assistant's confirm gate fails closed, so a
    //                             missing cache refused every confirm
    //   device:online:            device presence; without it no device shows
    //                             online or Watch-Together-capable
    //   v1:maintenance:notice     the admin maintenance notice (set-NX guarded)
    'mal:oauth:',
    'trakt:oauth:',
    'assistant-confirm:',
    'device:online:',
    'v1:maintenance:notice',
    // OIDC back-channel logout replay guard (jti seen markers, 10 min TTL).
    'oidc:bcl:jti:',
    // Provider telemetry is shared by web + workers on the task instance.
    'pcalls:v1:',
];

/** The closed coordination prefix list, for the classification guard test. */
export function coordinationKeyPrefixes(): readonly string[] {
    return COORDINATION_KEY_PREFIXES;
}

/** True when `key` belongs to the noeviction coordination keyspace. */
export function isCoordinationKey(key: string): boolean {
    for (const prefix of COORDINATION_KEY_PREFIXES) {
        if (key.startsWith(prefix)) return true;
    }
    return false;
}

let valkeyClient: GlideClient | null = null;
let connectPromise: Promise<boolean> | null = null;
let connectionRequested = false;
let connectionGeneration = 0;

// Dedicated coordination client — only instantiated when COORD_IS_SEPARATE.
let coordClient: GlideClient | null = null;
let coordConnectPromise: Promise<boolean> | null = null;

// Lock contention metrics
interface LockMetrics {
    acquisitionAttempts: number;
    acquisitionSuccesses: number;
    acquisitionFailures: number;
    releaseAttempts: number;
    releaseSuccesses: number;
    releaseFailures: number;
    heartbeatAttempts: number;
    heartbeatFailures: number;
    totalHoldDurationMs: number;
    lockCount: number;
}

const lockMetrics: LockMetrics = {
    acquisitionAttempts: 0,
    acquisitionSuccesses: 0,
    acquisitionFailures: 0,
    releaseAttempts: 0,
    releaseSuccesses: 0,
    releaseFailures: 0,
    heartbeatAttempts: 0,
    heartbeatFailures: 0,
    totalHoldDurationMs: 0,
    lockCount: 0,
};

// Track lock acquisition times for hold duration
const lockAcquisitionTimes = new Map<string, number>();

// In-memory fallback for locks when Valkey unavailable (for testing and graceful degradation)
interface InMemoryLock {
    value: string;
    expiresAt: number;
}
const memoryLocks = new Map<string, InMemoryLock>();

// Parse Redis URL to extract connection details
function parseRedisUrl(
    url: string,
    name = 'CACHE_URL',
    defaultDatabase = 0,
): {
    host: string;
    port: number;
    username?: string;
    password?: string;
    database?: number;
    tls: boolean;
} | null {
    try {
        if (!url) return null;
        return parseValkeyEndpoint(url, name, defaultDatabase);
    } catch {
        // Invalid URLs and Node's URL errors (.input) can contain credentials.
        logger.warn('Failed to parse Valkey URL');
        return null;
    }
}

/**
 * Get Valkey client - returns existing client or null if not connected
 */
export function getValkeyClient(): GlideClient | null {
    return valkeyClient;
}

/**
 * The coordination/task client — the dedicated `noeviction` instance.
 * Raw-client coordination call sites (orchestrator, runner,
 * log-buffer, leader probes, etc.) MUST use this instead of getValkeyClient() so
 * their keys land on the instance that won't evict them.
 */
export function getCoordinationClient(): GlideClient | null {
    // Lazy self-heal: if a previous connect failed (or the coord box was down at
    // boot), kick a best-effort background reconnect. This call still returns
    // null (locks fail closed and keyed writes no-op), but
    // the next call picks up the recovered client.
    if (!coordClient && !coordConnectPromise && connectionRequested && TASK_VALKEY_URL) {
        void connectCoordClient();
    }
    return coordClient;
}

/** True when TASK_CACHE_URL routes coordination keys to another Valkey instance. */
export function hasSeparateCoordinationValkey(): boolean {
    return COORD_IS_SEPARATE;
}

/**
 * Route a keyed operation to the correct client: coordination keys → the
 * noeviction instance, everything else → the evictable cache instance.
 */
function pickClient(key: string): GlideClient | null {
    return isCoordinationKey(key) ? getCoordinationClient() : valkeyClient;
}

/**
 * Delete keys, grouping each by its resolved client so a mixed-keyspace array
 * hits BOTH instances. Single-keyspace arrays use one DEL.
 */
async function delAcrossKeyspaces(keys: string[], label: string): Promise<number> {
    if (keys.length === 0) return 0;
    const groups = new Map<GlideClient, string[]>();
    for (const key of keys) {
        const client = pickClient(key);
        if (!client) continue;
        const group = groups.get(client);
        if (group) group.push(key);
        else groups.set(client, [key]);
    }
    let deleted = 0;
    for (const [client, group] of groups) {
        try {
            deleted += await client.del(group);
        } catch (error) {
            logger.warn(`${label} failed`, { keys: group }, error as Error);
        }
    }
    return deleted;
}

/**
 * Pattern ops route to ONE client by the pattern's literal prefix. A pattern with
 * no literal prefix (starts with a wildcard) can't be routed deterministically —
 * it only scans the cache instance, silently missing coordination keys. Warn so
 * the footgun is visible. Only relevant when the two instances are separate.
 */
function warnIfUnroutablePattern(pattern: string, op: string): void {
    if (!COORD_IS_SEPARATE) return;
    const wildcardAt = pattern.search(/[*?[]/);
    const literal = wildcardAt === -1 ? pattern : pattern.slice(0, wildcardAt);
    if (literal === '') {
        logger.warn(
            `${op}: pattern '${pattern}' has no literal prefix — scans the cache instance only; ` +
                'coordination keys will not be matched. Scope the pattern to one keyspace.',
            { pattern: truncateKeyForLog(pattern) },
        );
    }
}

/**
 * Check if Valkey client is connected and ready.
 *
 * Synchronous presence check — does NOT talk to the server. Used by hot-path
 * callers that can't await. For callers who need actual round-trip health
 * (e.g. cluster heartbeat reclaim), see {@link isValkeyHealthy}.
 */
export function isValkeyReady(): boolean {
    // The best-effort CACHE client only. Gate coordination-key work (locks,
    // revocations, Watch Together, device commands …) on
    // isCoordinationValkeyReady() / isValkeyReadyFor(key) instead: with the
    // cache down or CACHE_URL unset this stays false while those keys work.
    return valkeyClient !== null;
}

/**
 * Health-check the Valkey connection with a live PING.
 *
 * L3 — `isValkeyReady()` returns true whenever the client object exists,
 * which persists through network partitions and ioredis reconnect storms.
 * Callers that must not act on stale liveness (e.g. the scheduler's live-
 * replica enumeration) need an actual round-trip guarantee. This helper
 * sends PING with a short timeout and returns true only on 'PONG'.
 *
 * Returns false on any failure — connection down, timeout, unexpected
 * response. Callers should treat false as "unknown health" and fall back
 * to their safe-default path, NOT as "cluster is empty".
 */
export async function isValkeyHealthy(timeoutMs = 500): Promise<boolean> {
    return pingHealthy(valkeyClient, timeoutMs);
}

/**
 * {@link isValkeyHealthy} for the coordination/task instance. Only meaningful
 * when {@link hasSeparateCoordinationValkey}; otherwise it pings the same client.
 */
export async function isCoordinationValkeyHealthy(timeoutMs = 500): Promise<boolean> {
    return pingHealthy(getCoordinationClient(), timeoutMs);
}

async function pingHealthy(client: GlideClient | null, timeoutMs: number): Promise<boolean> {
    if (!client) return false;
    try {
        // Attach a no-op catch BEFORE racing. If the timeout wins, the
        // underlying ping() still eventually resolves/rejects. Without this
        // guard the eventual rejection hits a dead awaiter and Node surfaces
        // it as an unhandled promise rejection (log noise under default
        // settings, hard crash under `--unhandled-rejections=strict`).
        //
        // The sentinel object is distinct from any valid PING response so
        // the race result can be pattern-matched unambiguously.
        const pingSentinel = Symbol('valkey-ping-failed');
        const pingPromise = client.ping().catch((err: unknown): typeof pingSentinel => {
            logger.debug('Valkey ping rejected after race resolved', {
                error: err instanceof Error ? err.message : String(err),
            });
            return pingSentinel;
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
            const t = setTimeout(
                () => reject(new Error(`Valkey ping timed out after ${timeoutMs}ms`)),
                timeoutMs,
            );
            // Don't hold the event loop for the timeout.
            if (typeof t.unref === 'function') t.unref();
        });
        const result = await Promise.race([pingPromise, timeoutPromise]);
        if (result === pingSentinel) return false;
        return result === 'PONG';
    } catch (error) {
        logger.debug('Valkey health check failed', {
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}

/**
 * Connect to Valkey using valkey-glide
 * Uses a shared promise to prevent concurrent connection attempts
 */
function closeConnection(client: GlideClient | null, label: string): void {
    if (!client) return;
    try {
        client.close();
    } catch (error) {
        logger.warn(`Error closing Valkey ${label} connection`, {}, error as Error);
    }
}

function connectionIsCurrent(generation: number): boolean {
    return connectionRequested && generation === connectionGeneration;
}

/**
 * Connect Valkey. The coordination/task instance is REQUIRED and connects first
 * and independently: the return value is its result. The disposable cache is
 * best-effort — an unreachable or unset CACHE_URL never fails this call. The
 * first connect waits for one cache attempt so a healthy install starts with a
 * warm L2; after that a failed cache retries in the background with backoff and
 * callers fall through to cache misses meanwhile.
 */
export async function connectValkey(): Promise<boolean> {
    // Configuration errors must not degrade into cache misses or retry storms.
    const endpoints = assertValkeyEndpointConfiguration({
        CACHE_URL: VALKEY_URL,
        TASK_CACHE_URL: TASK_VALKEY_URL,
    });
    connectionRequested = true;
    const generation = connectionGeneration;
    const coordination = await connectCoordClient();
    if (endpoints.cache && !valkeyClient) {
        if (!cacheFirstAttemptDone) {
            // Bounded: an unreachable cache host must not stall boot or the
            // readiness probe. Concurrent first callers share the one attempt
            // and the one deadline; the attempt keeps running (and retries)
            // after the deadline passes.
            cacheFirstWaitUntil ??= Date.now() + FIRST_CACHE_CONNECT_WAIT_MS;
            const remaining = cacheFirstWaitUntil - Date.now();
            if (remaining > 0) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([
                    connectCacheClient(),
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, remaining);
                        timer.unref?.();
                    }),
                ]);
                clearTimeout(timer);
            }
        } else {
            scheduleCacheReconnect();
        }
    }
    return connectionIsCurrent(generation) && coordination && coordClient !== null;
}

/** The first cache attempt has run (successful or not) in this generation. */
let cacheFirstAttemptDone = false;
/** Deadline shared by every caller waiting on the first cache attempt. */
let cacheFirstWaitUntil: number | null = null;
let cacheRetryTimer: ReturnType<typeof setTimeout> | null = null;
let cacheRetryDelayMs = 0;
const CACHE_RETRY_MIN_MS = 1_000;
const FIRST_CACHE_CONNECT_WAIT_MS = 3_000;
const CACHE_RETRY_MAX_MS = 30_000;

/** Background reconnect for the best-effort cache, exponential backoff, unref'd. */
function scheduleCacheReconnect(): void {
    if (cacheRetryTimer || connectPromise || valkeyClient || !connectionRequested || !VALKEY_URL)
        return;
    cacheRetryDelayMs = Math.min(
        CACHE_RETRY_MAX_MS,
        Math.max(CACHE_RETRY_MIN_MS, cacheRetryDelayMs * 2),
    );
    const generation = connectionGeneration;
    cacheRetryTimer = setTimeout(() => {
        cacheRetryTimer = null;
        if (!connectionIsCurrent(generation) || valkeyClient) return;
        void connectCacheClient().then((ok) => {
            if (!ok) scheduleCacheReconnect();
        });
    }, cacheRetryDelayMs);
    cacheRetryTimer.unref?.();
}

/** One cache connect attempt; never throws. Schedules a retry on failure. */
async function connectCacheClient(): Promise<boolean> {
    if (!connectionRequested) return false;
    if (valkeyClient) return true;
    if (connectPromise) return connectPromise;
    const generation = connectionGeneration;
    const attempt = (async (): Promise<boolean> => {
        let created: GlideClient | null = null;
        try {
            const config = assertValkeyEndpointConfiguration({
                CACHE_URL: VALKEY_URL,
                TASK_CACHE_URL: TASK_VALKEY_URL,
            }).cache;
            if (!config) return false;
            const clientConfig: Parameters<typeof GlideClient.createClient>[0] = {
                addresses: [{ host: config.host, port: config.port }],
                requestTimeout: 10000,
                useTLS: config.tls,
                clientName: 'lumastra',
                databaseId: config.database,
            };
            if (config.password) {
                clientConfig.credentials = {
                    username: config.username || 'default',
                    password: config.password,
                };
            }
            created = await GlideClient.createClient(clientConfig);
            if (!connectionIsCurrent(generation)) return false;
            const pong = await created.ping();
            if (!connectionIsCurrent(generation)) return false;
            if (pong !== 'PONG') {
                logger.warn('Valkey cache ping failed', { response: pong });
                return false;
            }
            valkeyClient = created;
            created = null; // The current generation now owns this verified client.
            cacheRetryDelayMs = 0;
            logger.info('Connected to Valkey cache', { host: config.host, port: config.port });
            return true;
        } catch (error) {
            // Warn once per outage; the background retry keeps trying quietly.
            if (cacheRetryDelayMs === 0) {
                logger.warn(
                    'Valkey cache unavailable; continuing without it (cache misses) and retrying in the background',
                    {},
                    error as Error,
                );
            } else {
                logger.debug('Valkey cache still unavailable', {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return false;
        } finally {
            closeConnection(created, 'unverified cache');
        }
    })();
    connectPromise = attempt;
    try {
        const ok = await attempt;
        return ok;
    } finally {
        if (connectPromise === attempt) connectPromise = null;
        if (connectionIsCurrent(generation)) {
            cacheFirstAttemptDone = true;
            if (!valkeyClient) scheduleCacheReconnect();
        }
    }
}

/** Connect only the dedicated noeviction instance, never the cache fallback. */
async function connectCoordClient(): Promise<boolean> {
    if (!connectionRequested) return false;
    if (coordConnectPromise) return coordConnectPromise;
    if (coordClient) return true;
    const generation = connectionGeneration;
    const attempt = (async (): Promise<boolean> => {
        let created: GlideClient | null = null;
        try {
            const config = assertValkeyEndpointConfiguration({
                CACHE_URL: VALKEY_URL,
                TASK_CACHE_URL: TASK_VALKEY_URL,
            }).task;
            const clientConfig: Parameters<typeof GlideClient.createClient>[0] = {
                addresses: [{ host: config.host, port: config.port }],
                requestTimeout: 10000,
                useTLS: config.tls,
                clientName: 'lumastra-coord',
                databaseId: config.database,
            };
            if (config.password) {
                clientConfig.credentials = {
                    username: config.username || 'default',
                    password: config.password,
                };
            }
            created = await GlideClient.createClient(clientConfig);
            if (!connectionIsCurrent(generation)) return false;
            const pong = await created.ping();
            if (!connectionIsCurrent(generation)) return false;
            if (pong !== 'PONG') {
                logger.warn('Valkey coordination ping failed', { response: pong });
                return false;
            }
            coordClient = created;
            created = null;
            logger.info('Connected to Valkey coordination instance', {
                host: config.host,
                port: config.port,
            });
            return true;
        } catch (error) {
            logger.error('Failed to connect to Valkey coordination instance', error as Error);
            return false;
        } finally {
            closeConnection(created, 'unverified coordination');
        }
    })();
    coordConnectPromise = attempt;
    try {
        return await attempt;
    } finally {
        if (coordConnectPromise === attempt) coordConnectPromise = null;
    }
}

/**
 * The process is about to exit. GLIDE's Rust core logs ERROR lines while its
 * clients close (`Failed to unsubscribe ... Internal client has been dropped`,
 * `received error ...` against a server that stopped with us). They carry no
 * information at that point and showed up as errors in every full-stack restart.
 */
export function silenceGlideLoggerForShutdown(): void {
    try {
        GlideLogger.setLoggerConfig('off');
    } catch {
        // Best-effort (and absent under module mocks).
    }
}

/** Late creates/PINGs from an older connection generation can never resurrect it. */
export async function disconnectValkey(): Promise<void> {
    silenceGlideLoggerForShutdown();
    connectionRequested = false;
    connectionGeneration++;
    const cache = valkeyClient;
    const coordination = coordClient;
    valkeyClient = null;
    coordClient = null;
    connectPromise = null;
    coordConnectPromise = null;
    cacheFirstAttemptDone = false;
    cacheFirstWaitUntil = null;
    cacheRetryDelayMs = 0;
    if (cacheRetryTimer) clearTimeout(cacheRetryTimer);
    cacheRetryTimer = null;
    closeConnection(cache, 'cache');
    closeConnection(coordination, 'coordination');
}

/**
 * Test Valkey connectivity: the REQUIRED coordination instance answers PING.
 * The cache is best-effort and never decides this (see {@link isValkeyHealthy}).
 */
export async function testValkeyConnection(): Promise<boolean> {
    try {
        if (!(await connectValkey())) return false;
        return await isCoordinationValkeyHealthy(2000);
    } catch (error) {
        logger.warn('Valkey coordination health check failed', {}, error as Error);
        return false;
    }
}

/**
 * Run the task-store boot guard (cache/task-valkey-guard.ts) against the live
 * clients. Policy checks always; `sql` adds the worker-only data checks (task
 * data in the selected DB, no silently-empty store). Throws
 * TaskValkeyGuardError with an operator-facing message.
 */
export async function guardTaskValkey(sql?: postgres.Sql): Promise<void> {
    const { assertTaskValkeyPolicy, assertTaskValkeyData } = await import('./task-valkey-guard.js');
    const endpoints = assertValkeyEndpointConfiguration({
        CACHE_URL: VALKEY_URL,
        TASK_CACHE_URL: TASK_VALKEY_URL,
    });
    const task = coordClient;
    if (!task) throw new Error('Task Valkey is not connected');
    const warn = (message: string, meta?: Record<string, unknown>): void =>
        logger.warn(message, meta ?? {});
    const options = {
        task,
        cache: valkeyClient,
        taskDatabase: endpoints.task.database,
        warn,
    };
    if (!options.cache && VALKEY_URL) {
        warn(
            'Cache Valkey not connected at boot: could not verify that CACHE_URL and TASK_CACHE_URL are different servers (run_id)',
        );
    }
    await assertTaskValkeyPolicy(options);
    if (!sql) return;
    await assertTaskValkeyData({
        ...options,
        sql,
        openDatabase: async (db) => {
            const config = endpoints.task;
            const clientConfig: Parameters<typeof GlideClient.createClient>[0] = {
                addresses: [{ host: config.host, port: config.port }],
                requestTimeout: 10000,
                useTLS: config.tls,
                clientName: 'lumastra-guard',
                databaseId: db,
            };
            if (config.password) {
                clientConfig.credentials = {
                    username: config.username || 'default',
                    password: config.password,
                };
            }
            const client = await GlideClient.createClient(clientConfig);
            return {
                customCommand: (args: string[]) => client.customCommand(args),
                close: () => closeConnection(client, 'guard'),
            };
        },
    });
}

/** Sync presence check for the coordination/task client (no round trip). */
export function isCoordinationValkeyReady(): boolean {
    return getCoordinationClient() !== null;
}

/**
 * Sync presence check for the client a key routes to. Use this — not
 * {@link isValkeyReady}, which only reports the best-effort cache — before a
 * keyed operation whose key may be a coordination key.
 */
export function isValkeyReadyFor(key: string): boolean {
    return pickClient(key) !== null;
}

/** CACHE_URL is configured (false = in-memory caching only, by choice). */
export function isCacheValkeyConfigured(): boolean {
    return VALKEY_URL !== '';
}

// ============================================================================
// Cache Operations - Wrapper functions for unified-cache.ts compatibility
// ============================================================================

/**
 * Convert GlideString (string | Buffer) to string
 * GlideString from valkey-glide can be string or Buffer (Uint8Array)
 */
function glideStringToString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (value instanceof Uint8Array || value instanceof Buffer) {
        return Buffer.from(value).toString('utf-8');
    }
    return String(value);
}

/**
 * A key can embed caller-supplied text (a Quick Connect secret off an
 * anonymous request); a failure log must not write all of it.
 */
export function truncateKeyForLog(key: string, max = 96): string {
    return key.length > max ? `${key.slice(0, max)}...(${key.length} chars)` : key;
}

/**
 * Get a value from cache
 */
export async function cacheGet(key: string): Promise<string | null> {
    const client = pickClient(key);
    if (!client) return null;
    try {
        const result = await client.get(key);
        return glideStringToString(result);
    } catch (error) {
        logger.warn('Cache get failed', { key: truncateKeyForLog(key) }, error as Error);
        return null;
    }
}

/**
 * Like {@link cacheGet}, but THROWS when no client is configured or the GET
 * fails, so a caller can tell "key absent" from "could not ask". `cacheGet`
 * swallows both into `null`, which read as "not revoked" in the token
 * revocation checks during a real Valkey outage (isValkeyReady() stays true
 * while the client object exists).
 */
export async function cacheGetOrThrow(key: string): Promise<string | null> {
    const client = pickClient(key);
    if (!client)
        throw Object.assign(new Error('Valkey client not available'), { name: 'ConnectionError' });
    return glideStringToString(await client.get(key));
}

/**
 * Atomic GET + DEL: return the value and remove the key in a single operation.
 * Use for single-use tokens/transactions (e.g. the OIDC login state) where a
 * separate get()+del() leaves a read-then-delete race that two concurrent callers
 * could both win. Returns null if absent or on error.
 */
export async function getDel(key: string): Promise<string | null> {
    const client = pickClient(key);
    if (!client) return null;
    try {
        const result = await client.getdel(key);
        return glideStringToString(result);
    } catch (error) {
        logger.warn('Cache getdel failed', { key: truncateKeyForLog(key) }, error as Error);
        return null;
    }
}

/**
 * Set a value in cache with optional TTL in seconds
 */
export async function cacheSet(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    const client = pickClient(key);
    if (!client) return false;
    try {
        if (ttlSeconds) {
            await client.set(key, value, {
                expiry: { type: TimeUnit.Seconds, count: ttlSeconds },
            });
        } else {
            await client.set(key, value);
        }
        return true;
    } catch (error) {
        logger.warn('Cache set failed', { key: truncateKeyForLog(key) }, error as Error);
        return false;
    }
}

/**
 * Delete a key from cache
 */
export async function cacheDel(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    return delAcrossKeyspaces(keys, 'Cache del');
}

/**
 * Check if a key exists
 */
export async function cacheExists(key: string): Promise<boolean> {
    const client = pickClient(key);
    if (!client) return false;
    try {
        const count = await client.exists([key]);
        return count > 0;
    } catch (error) {
        logger.warn('Cache exists check failed', { key: truncateKeyForLog(key) }, error as Error);
        return false;
    }
}

/**
 * Remaining TTL for a key, in seconds.
 *
 * Returns -1 when the key exists but has no expiry, -2 when the key is absent
 * OR Valkey is unreachable (mirrors the raw Valkey TTL contract for "absent",
 * and folds the unreachable case into it since neither carries a usable
 * expiry). Callers deciding whether to DISPLAY an expiry must treat both as
 * "no expiry to show" — never surface -2 as if it were a real value.
 */
export async function getKeyTtlSeconds(key: string): Promise<number> {
    const client = pickClient(key);
    if (!client) return -2;
    try {
        return await client.ttl(key);
    } catch (error) {
        logger.warn('TTL check failed', { key: truncateKeyForLog(key) }, error as Error);
        return -2;
    }
}

// ============================================================================
// Redis-compatible API wrappers (for watch-together.service.ts compatibility)
// ============================================================================

/**
 * Set a key with TTL in seconds (setEx equivalent)
 */
export async function setEx(key: string, seconds: number, value: string): Promise<boolean> {
    const client = pickClient(key);
    if (!client) return false;
    try {
        await client.set(key, value, {
            expiry: { type: TimeUnit.Seconds, count: seconds },
        });
        return true;
    } catch (error) {
        logger.warn('setEx failed', { key: truncateKeyForLog(key) }, error as Error);
        return false;
    }
}

/**
 * Atomically set a key ONLY if it doesn't exist (SET NX)
 * Returns true if key was set, false if key already exists
 *
 * Use this to prevent race conditions when multiple processes try to create the same key.
 * Example: Tracking sessions where duplicate tracking must be prevented.
 */
export async function setIfNotExists(
    key: string,
    value: string,
    ttlSeconds?: number,
): Promise<boolean> {
    const client = pickClient(key);
    if (!client) return false;
    try {
        const options: {
            conditionalSet: 'onlyIfDoesNotExist';
            expiry?: { type: TimeUnit; count: number };
        } = {
            conditionalSet: 'onlyIfDoesNotExist',
        };

        if (ttlSeconds) {
            options.expiry = { type: TimeUnit.Seconds, count: ttlSeconds };
        }

        const result = await client.set(key, value, options);
        // SET NX returns 'OK' if set, null if key already exists
        return result === 'OK';
    } catch (error) {
        logger.warn('setIfNotExists failed', { key: truncateKeyForLog(key) }, error as Error);
        return false;
    }
}

/**
 * Set expiration on a key
 */
export async function expire(key: string, seconds: number): Promise<boolean> {
    // Track heartbeat metrics for lock keys
    const isLockKey = key.includes('lock:');
    if (isLockKey) {
        lockMetrics.heartbeatAttempts++;
    }

    const client = pickClient(key);

    // Use in-memory fallback if Valkey not connected
    if (!client) {
        logger.debug('Using in-memory fallback for expire', { key: truncateKeyForLog(key) });

        const lock = memoryLocks.get(key);
        if (lock) {
            // Extend the TTL
            lock.expiresAt = Date.now() + seconds * 1000;
            logger.debug('Extended lock TTL (memory backend)', {
                key: truncateKeyForLog(key),
                seconds,
            });
            return true;
        }

        // Key doesn't exist
        if (isLockKey) lockMetrics.heartbeatFailures++;
        return false;
    }

    try {
        const result = await client.expire(key, seconds);
        if (isLockKey && !result) {
            lockMetrics.heartbeatFailures++;
        }
        return result;
    } catch (error) {
        if (isLockKey) lockMetrics.heartbeatFailures++;
        logger.warn('expire failed', { key: truncateKeyForLog(key) }, error as Error);
        return false;
    }
}

// ============================================================================
// Distributed Locking (for multi-replica coordination)
// ============================================================================

/**
 * Acquire a distributed lock using SET NX (set if not exists)
 * Used to prevent multiple replicas from doing the same work simultaneously
 *
 * @param lockKey - Unique key for the lock
 * @param ttlSeconds - Lock expiration time (prevents deadlocks if holder crashes)
 * @param lockValue - Optional value to identify the lock holder (defaults to random ID)
 * @returns The lock value if acquired, null if lock is already held
 */
export async function acquireLock(
    lockKey: string,
    ttlSeconds: number,
    lockValue?: string,
): Promise<string | null> {
    lockMetrics.acquisitionAttempts++;

    const value =
        lockValue || `lock-${process.pid}-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Locks are coordination state — route to the coordination instance.
    const client = pickClient(lockKey);

    // Use in-memory fallback if Valkey not connected
    if (!client) {
        // When a dedicated coordination instance is configured but is currently
        // unreachable, the in-memory store is per-process: granting the lock
        // here would give each replica its own "exclusive" lock, which provides
        // no cross-replica exclusion at all. Fail closed so callers get null
        // (contended / unavailable) instead of a lock that silently lies about
        // being exclusive. Single-instance and dev deployments (COORD_IS_SEPARATE
        // === false) are unaffected — the in-memory fallback is valid there.
        if (COORD_IS_SEPARATE) {
            lockMetrics.acquisitionFailures++;
            logger.warn(
                'acquireLock: coordination Valkey is unavailable — refusing in-memory ' +
                    'fallback for cross-replica lock (fail-closed). ' +
                    'Resolve TASK_CACHE_URL connectivity to restore distributed locking.',
                { lockKey: truncateKeyForLog(lockKey) },
            );
            return null;
        }

        // Clean up expired locks
        const now = Date.now();
        for (const [key, lock] of memoryLocks.entries()) {
            if (lock.expiresAt < now) {
                memoryLocks.delete(key);
            }
        }

        // Check if lock exists and is not expired
        const existingLock = memoryLocks.get(lockKey);
        if (existingLock && existingLock.expiresAt > now) {
            lockMetrics.acquisitionFailures++;
            logger.debug('Lock already held (memory backend)', {
                lockKey: truncateKeyForLog(lockKey),
                reason: 'held',
            });
            return null;
        }

        // Acquire lock
        memoryLocks.set(lockKey, {
            value,
            expiresAt: now + ttlSeconds * 1000,
        });
        lockMetrics.acquisitionSuccesses++;
        lockMetrics.lockCount++;
        lockAcquisitionTimes.set(value, now);
        logger.debug('Lock acquired (memory backend)', {
            lockKey: truncateKeyForLog(lockKey),
            ttlSeconds,
        });
        return value;
    }

    try {
        // SET key value NX EX ttl - only sets if key doesn't exist
        const result = await client.set(lockKey, value, {
            conditionalSet: 'onlyIfDoesNotExist',
            expiry: { type: TimeUnit.Seconds, count: ttlSeconds },
        });

        // Returns 'OK' if set, null if key already exists
        if (result === 'OK') {
            lockMetrics.acquisitionSuccesses++;
            lockMetrics.lockCount++;
            lockAcquisitionTimes.set(value, Date.now());
            logger.debug('Lock acquired', { lockKey: truncateKeyForLog(lockKey), ttlSeconds });
            return value;
        }

        // Lock already held by another process (normal, expected in multi-replica setup)
        lockMetrics.acquisitionFailures++;
        logger.debug('Lock already held by another replica (normal contention)', {
            lockKey: truncateKeyForLog(lockKey),
            reason: 'held',
        });
        return null;
    } catch (error) {
        // Connection error or other critical failure
        lockMetrics.acquisitionFailures++;
        logger.error('CRITICAL: Failed to acquire lock due to Valkey error', error as Error, {
            lockKey: truncateKeyForLog(lockKey),
            reason: 'connection_error',
        });
        return null;
    }
}

/**
 * Release a distributed lock
 * Only releases if the lock value matches (prevents releasing someone else's lock)
 * Uses atomic Lua script to prevent race conditions
 *
 * @param lockKey - The lock key to release
 * @param lockValue - The value returned from acquireLock (for ownership verification)
 * @returns true if lock was released, false otherwise
 */
export async function releaseLock(lockKey: string, lockValue: string): Promise<boolean> {
    lockMetrics.releaseAttempts++;

    const client = pickClient(lockKey);

    // Use in-memory fallback if Valkey not connected
    if (!client) {
        logger.debug('Using in-memory lock fallback for release', {
            lockKey: truncateKeyForLog(lockKey),
        });

        const existingLock = memoryLocks.get(lockKey);
        const now = Date.now();

        // Check if lock exists, matches our value, and hasn't expired
        if (existingLock && existingLock.value === lockValue && existingLock.expiresAt > now) {
            // Release the lock
            memoryLocks.delete(lockKey);
            lockMetrics.releaseSuccesses++;

            // Calculate hold duration
            const acquiredAt = lockAcquisitionTimes.get(lockValue);
            if (acquiredAt) {
                const holdDuration = Date.now() - acquiredAt;
                lockMetrics.totalHoldDurationMs += holdDuration;
                lockAcquisitionTimes.delete(lockValue);
            }

            logger.debug('Lock released successfully (memory backend)', {
                lockKey: truncateKeyForLog(lockKey),
            });
            return true;
        }

        // Lock not owned or already expired
        lockMetrics.releaseFailures++;

        // Clean up tracking even if release failed
        const acquiredAt = lockAcquisitionTimes.get(lockValue);
        if (acquiredAt) {
            lockAcquisitionTimes.delete(lockValue);
            logger.debug('Cleaned up expired lock tracking (memory backend)', {
                lockKey: truncateKeyForLog(lockKey),
                lockValue,
            });
        }

        logger.debug('Lock not owned or already expired (memory backend)', {
            lockKey: truncateKeyForLog(lockKey),
            reason: 'not_owned_or_expired',
        });
        return false;
    }

    try {
        // Atomic Lua script: only delete if value matches
        // Returns 1 if deleted, 0 if not owned or key doesn't exist
        const luaScript = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        `;

        // Execute Lua script atomically via EVAL command
        // KEYS[1] = lockKey, ARGV[1] = lockValue
        const result = await client.customCommand([
            'EVAL',
            luaScript,
            '1', // Number of keys
            lockKey,
            lockValue,
        ]);

        // Result is 1 if deleted, 0 if not owned
        const deleted = result === 1 || result === '1';

        if (deleted) {
            lockMetrics.releaseSuccesses++;

            // Calculate hold duration if we tracked acquisition
            const acquiredAt = lockAcquisitionTimes.get(lockValue);
            if (acquiredAt) {
                const holdDuration = Date.now() - acquiredAt;
                lockMetrics.totalHoldDurationMs += holdDuration;
                lockAcquisitionTimes.delete(lockValue);
            }

            logger.debug('Lock released successfully', { lockKey: truncateKeyForLog(lockKey) });
        } else {
            lockMetrics.releaseFailures++;

            // Clean up tracking even if release failed (lock expired via TTL)
            // This prevents memory leak when locks expire naturally
            const acquiredAt = lockAcquisitionTimes.get(lockValue);
            if (acquiredAt) {
                // Don't count hold duration for expired locks in metrics
                lockAcquisitionTimes.delete(lockValue);
                logger.debug('Cleaned up expired lock tracking', {
                    lockKey: truncateKeyForLog(lockKey),
                    lockValue,
                });
            }

            logger.warn(
                'Lock not owned by us or already expired (normal if task exceeded max duration)',
                {
                    lockKey: truncateKeyForLog(lockKey),
                    expected: lockValue,
                    reason: 'not_owned_or_expired',
                },
            );
        }

        return deleted;
    } catch (error) {
        lockMetrics.releaseFailures++;
        logger.error('CRITICAL: Failed to release lock due to Valkey error', error as Error, {
            lockKey: truncateKeyForLog(lockKey),
            reason: 'connection_error',
        });
        return false;
    }
}

/**
 * Renew (extend TTL of) a distributed lock — only if we still hold it.
 * Atomic Lua script: checks value matches before calling EXPIRE.
 * Returns false if the lock has expired or is held by another replica.
 *
 * Use this for heartbeats — prevents accidentally renewing another replica's lock.
 */
export async function renewLock(
    lockKey: string,
    lockValue: string,
    ttlSeconds: number,
): Promise<boolean> {
    lockMetrics.heartbeatAttempts++;

    const client = pickClient(lockKey);

    // In-memory fallback
    if (!client) {
        // Mirror the acquireLock fail-closed policy: in HA mode with a separate
        // coordination instance, renewing via the per-process in-memory store
        // would extend a lock that was never cross-replica-exclusive. Fail closed.
        if (COORD_IS_SEPARATE) {
            lockMetrics.heartbeatFailures++;
            logger.warn(
                'renewLock: coordination Valkey is unavailable — refusing in-memory ' +
                    'fallback for cross-replica lock (fail-closed).',
                { lockKey: truncateKeyForLog(lockKey) },
            );
            return false;
        }
        const lock = memoryLocks.get(lockKey);
        const now = Date.now();
        if (lock && lock.value === lockValue && lock.expiresAt > now) {
            lock.expiresAt = now + ttlSeconds * 1000;
            return true;
        }
        lockMetrics.heartbeatFailures++;
        return false;
    }

    try {
        const luaScript = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("expire", KEYS[1], ARGV[2])
            else
                return 0
            end
        `;
        const result = await client.customCommand([
            'EVAL',
            luaScript,
            '1',
            lockKey,
            lockValue,
            String(ttlSeconds),
        ]);
        const renewed = result === 1 || result === '1';
        if (!renewed) lockMetrics.heartbeatFailures++;
        return renewed;
    } catch (error) {
        lockMetrics.heartbeatFailures++;
        logger.warn('renewLock failed', { lockKey: truncateKeyForLog(lockKey) }, error as Error);
        return false;
    }
}

/**
 * Get lock contention metrics
 * Provides visibility into lock usage patterns and potential issues
 *
 * @returns Lock metrics including acquisition/release stats and average hold duration
 */
export function getLockMetrics() {
    const averageHoldDurationMs =
        lockMetrics.releaseSuccesses > 0
            ? Math.round(lockMetrics.totalHoldDurationMs / lockMetrics.releaseSuccesses)
            : 0;

    const contentionRate =
        lockMetrics.acquisitionAttempts > 0
            ? ((lockMetrics.acquisitionFailures / lockMetrics.acquisitionAttempts) * 100).toFixed(2)
            : '0.00';

    return {
        ...lockMetrics,
        averageHoldDurationMs,
        contentionRate: `${contentionRate}%`,
        // Also expose active locks count
        activeLocksTracked: lockAcquisitionTimes.size,
    };
}

/**
 * Reset lock metrics (useful for testing or periodic reset)
 */
export function resetLockMetrics() {
    lockMetrics.acquisitionAttempts = 0;
    lockMetrics.acquisitionSuccesses = 0;
    lockMetrics.acquisitionFailures = 0;
    lockMetrics.releaseAttempts = 0;
    lockMetrics.releaseSuccesses = 0;
    lockMetrics.releaseFailures = 0;
    lockMetrics.heartbeatAttempts = 0;
    lockMetrics.heartbeatFailures = 0;
    lockMetrics.totalHoldDurationMs = 0;
    lockMetrics.lockCount = 0;
    lockAcquisitionTimes.clear();
}

/**
 * Add members to a set
 */
export async function sAdd(key: string, ...members: string[]): Promise<number> {
    const client = pickClient(key);
    if (!client) return 0;
    try {
        return await client.sadd(key, members);
    } catch (error) {
        logger.warn('sAdd failed', { key: truncateKeyForLog(key) }, error as Error);
        return 0;
    }
}

/**
 * Get set cardinality (number of members)
 */
export async function sCard(key: string): Promise<number> {
    const client = pickClient(key);
    if (!client) return 0;
    try {
        return await client.scard(key);
    } catch (error) {
        logger.warn('sCard failed', { key: truncateKeyForLog(key) }, error as Error);
        return 0;
    }
}

/**
 * Get all members of a set. Returns [] on failure or missing key.
 *
 * glide returns a `Set` of GlideString (string | Buffer depending on the
 * connection's decoder), so members are normalised to UTF-8 strings here —
 * callers get plain `string[]` and never have to care.
 */
export async function sMembers(key: string): Promise<string[]> {
    const client = pickClient(key);
    if (!client) return [];
    try {
        const members = await client.smembers(key);
        const out: string[] = [];
        for (const member of members) {
            const str = glideStringToString(member);
            if (str !== null) out.push(str);
        }
        return out;
    } catch (error) {
        logger.warn('sMembers failed', { key: truncateKeyForLog(key) }, error as Error);
        return [];
    }
}

/**
 * Remove members from a set
 */
export async function sRem(key: string, ...members: string[]): Promise<number> {
    const client = pickClient(key);
    if (!client) return 0;
    try {
        return await client.srem(key, members);
    } catch (error) {
        logger.warn('sRem failed', { key: truncateKeyForLog(key) }, error as Error);
        return 0;
    }
}

/**
 * Atomically admit `member` into a capped set: add it, and keep it only if
 * the set's cardinality stays within `cap` — all in one Lua script, so no
 * caller can observe a stale membership snapshot between deciding "may I?"
 * and writing "I do" (a separate `sMembers` + `sAdd` pair leaves exactly that
 * window open, and every concurrent caller in it observes the same pre-write
 * state). Follows the `customCommand(['EVAL', ...])` pattern `acquireLock`/
 * `releaseLock`/`renewLock` above already use for atomic Valkey operations —
 * the only precedent in this module.
 *
 * Also closes a second, narrower gap: the script installs the TTL in the
 * SAME operation that (re)admits the member, so there is no window where a
 * key exists on a `noeviction` instance with no expiry at all (which a
 * separate `SADD` + `EXPIRE` pair leaves open if the process dies or the
 * connection drops between the two calls).
 *
 * Semantics:
 *  - `member` already in the set: admitted for free (re-adding is a SADD
 *    no-op), TTL refreshed, returns true. A capped set must always admit a
 *    member it already holds, or a caller sitting at the cap could never
 *    make progress on work it already committed to.
 *  - `member` new and the set stays at or under `cap`: admitted, TTL
 *    (re)armed, returns true.
 *  - `member` new and admitting it would exceed `cap`: the just-added member
 *    is removed before returning, so a refusal never changes the set's
 *    membership — refused, returns false.
 *
 * Fails OPEN: when Valkey is unreachable (no client, or the script call
 * throws) this returns true. A capped set built on top of this is a fairness
 * measure, not a correctness guarantee — an outage in the cache must not
 * become an outage in whatever the cap is protecting.
 */
export async function sAddBounded(
    key: string,
    member: string,
    cap: number,
    ttlSeconds: number,
): Promise<boolean> {
    const client = pickClient(key);
    if (!client) return true; // fail open — see docstring

    try {
        const luaScript = `
            local added = redis.call("sadd", KEYS[1], ARGV[1])
            if added == 1 then
                local card = redis.call("scard", KEYS[1])
                if card > tonumber(ARGV[2]) then
                    redis.call("srem", KEYS[1], ARGV[1])
                    return 0
                end
            end
            redis.call("expire", KEYS[1], ARGV[3])
            return 1
        `;
        const result = await client.customCommand([
            'EVAL',
            luaScript,
            '1', // Number of keys
            key,
            member,
            String(cap),
            String(ttlSeconds),
        ]);
        return result === 1 || result === '1';
    } catch (error) {
        logger.warn('sAddBounded failed', { key: truncateKeyForLog(key) }, error as Error);
        return true; // fail open — see docstring
    }
}

/**
 * Remove members from a sorted set. Returns 0 on failure or missing key —
 * the sorted-set counterpart of `sRem` above.
 *
 * Releasing is best-effort by design: every caller of `zAddBoundedExpiring`
 * holds members that the script's own prune sweeps once they age past the
 * TTL, so a lost release costs a slot until then, never forever.
 */
export async function zRem(key: string, ...members: string[]): Promise<number> {
    const client = pickClient(key);
    if (!client) return 0;
    try {
        return await client.zrem(key, members);
    } catch (error) {
        logger.warn('zRem failed', { key: truncateKeyForLog(key) }, error as Error);
        return 0;
    }
}

/**
 * Count the members of a sorted set scored at or after `minScore`.
 *
 * Returns `null`, NOT 0, when the count cannot be read: for a capped set, 0
 * means "nothing is held" and is the single most misleading value an outage
 * could report. Callers must distinguish "empty" from "unknown".
 */
export async function zCountFrom(key: string, minScore: number): Promise<number | null> {
    const client = pickClient(key);
    if (!client) return null;
    try {
        const result = await client.customCommand(['ZCOUNT', key, String(minScore), '+inf']);
        const count = Number(result);
        return Number.isFinite(count) ? count : null;
    } catch (error) {
        logger.warn('zCountFrom failed', { key: truncateKeyForLog(key) }, error as Error);
        return null;
    }
}

/**
 * Atomically admit `member` into a capped set whose members expire
 * INDIVIDUALLY — the sorted-set sibling of `sAddBounded` above, scored by
 * acquisition time.
 *
 * ## Why not just use `sAddBounded`
 *
 * `sAddBounded` expires the whole KEY, and refreshes that TTL on every
 * admission. That is correct for a set whose members are always released by
 * the caller, but it is a self-inflicted outage for a set that holds
 * time-limited slots: a member leaked by a crashed holder is never swept
 * while traffic keeps arriving (each new admission pushes the key's TTL out
 * again), so the cap fills with zombies and refuses forever. Scoring members
 * by acquisition time lets the script drop exactly the stale ones.
 *
 * ## Atomicity
 *
 * Prune, count, admit and re-arm happen inside ONE Lua script, so no caller —
 * on this process or any other replica — can observe a membership snapshot
 * between deciding "may I?" and writing "I do". Uses the same
 * `customCommand(['EVAL', ...])` pattern as `acquireLock`/`sAddBounded`.
 *
 * Semantics (mirroring `sAddBounded`):
 *  - `member` already in the set: admitted for free, its score refreshed to
 *    `nowMs`, returns true.
 *  - `member` new and the set stays at or under `cap`: admitted, returns true.
 *  - `member` new and admitting it would exceed `cap`: the just-added member
 *    is removed before returning, so a refusal never changes membership —
 *    refused, returns false.
 *
 * ## `failOpen` is REQUIRED, with no default
 *
 * `sAddBounded` fails open, because a cache outage must not become a download
 * outage. This primitive's first caller needs the exact opposite: a Valkey
 * blip must not uncap unauthenticated ffmpeg spawning. Neither default is
 * safe for the other caller, so the policy is spelled at every call site
 * rather than inherited.
 *
 * `nowMs` is supplied by the caller rather than read from Valkey's `TIME`, to
 * keep the script deterministic and unit-testable. The prune boundary
 * (`nowMs - ttlMs`) is computed from whichever replica happens to call this
 * function next, so clock skew is not purely self-affecting: a replica whose
 * clock runs FAST computes a boundary further in the future than the other
 * replicas agree on, and its prune can sweep a member that ANOTHER, correctly
 * clocked replica admitted moments ago and still considers live — freeing
 * that slot for a new admission while the original holder's transcode is
 * still running. The failure mode is a brief window of OVER-admission (more
 * concurrent jobs than the cap for as long as the original holder takes to
 * finish or crash), not merely a shifted expiry for the fast replica's own
 * slots. Tolerable in practice at this primitive's 5-minute TTL on
 * NTP-synchronized nodes (skew is milliseconds to low seconds, negligible
 * against 300 seconds) — a deployment running nodes without clock discipline
 * should not rely on that margin.
 */
export async function zAddBoundedExpiring(
    key: string,
    member: string,
    cap: number,
    memberTtlSeconds: number,
    options: { failOpen: boolean; nowMs?: number },
): Promise<boolean> {
    const { failOpen } = options;
    const client = pickClient(key);
    if (!client) return failOpen;

    const nowMs = options.nowMs ?? Date.now();
    const ttlMs = Math.max(1, Math.round(memberTtlSeconds * 1000));

    try {
        const luaScript = `
            redis.call("zremrangebyscore", KEYS[1], "-inf", tonumber(ARGV[2]) - tonumber(ARGV[4]))
            local added = redis.call("zadd", KEYS[1], ARGV[2], ARGV[1])
            if added == 1 then
                local card = redis.call("zcard", KEYS[1])
                if card > tonumber(ARGV[3]) then
                    redis.call("zrem", KEYS[1], ARGV[1])
                    return 0
                end
            end
            redis.call("pexpire", KEYS[1], ARGV[4])
            return 1
        `;
        const result = await client.customCommand([
            'EVAL',
            luaScript,
            '1', // Number of keys
            key,
            member,
            String(nowMs),
            String(cap),
            String(ttlMs),
        ]);
        return result === 1 || result === '1';
    } catch (error) {
        logger.warn(
            'zAddBoundedExpiring failed',
            { key: truncateKeyForLog(key), failOpen },
            error as Error,
        );
        return failOpen;
    }
}

/**
 * Set hash field(s)
 */
export async function hSet(key: string, field: string, value: string): Promise<number> {
    const client = pickClient(key);
    if (!client) return 0;
    try {
        return await client.hset(key, { [field]: value });
    } catch (error) {
        logger.warn('hSet failed', { key: truncateKeyForLog(key), field }, error as Error);
        return 0;
    }
}

/** Add a hash member and retain at least its TTL, atomically across issuers. */
export async function hSetWithMaxTtl(
    key: string,
    field: string,
    value: string,
    ttlSeconds: number,
): Promise<void> {
    const client = pickClient(key);
    if (!client) throw new Error('Valkey unavailable for expiring hash write');
    await client.customCommand([
        'EVAL',
        `local added = redis.call('hset', KEYS[1], ARGV[1], ARGV[2])
         local ttl = redis.call('ttl', KEYS[1])
         if ttl < tonumber(ARGV[3]) then
             redis.call('expire', KEYS[1], ARGV[3])
         end
         return added`,
        '1',
        key,
        field,
        value,
        String(ttlSeconds),
    ]);
}

/** Set a hash field only if absent (atomic across replicas). */
export async function hSetNX(key: string, field: string, value: string): Promise<boolean> {
    const client = pickClient(key);
    if (!client) return false;
    try {
        const result = await client.customCommand(['HSETNX', key, field, value]);
        return result === 1 || result === '1';
    } catch (error) {
        logger.warn('hSetNX failed', { key: truncateKeyForLog(key), field }, error as Error);
        return false;
    }
}

/**
 * Fetch a single hash field. Cheaper than hGetAll when only one field is
 * needed — used by the run-group TTL post-incr verification path.
 */
export async function hGet(key: string, field: string): Promise<string | null> {
    const client = pickClient(key);
    if (!client) return null;
    try {
        const result = await client.hget(key, field);
        return glideStringToString(result as never);
    } catch (error) {
        logger.warn('hGet failed', { key: truncateKeyForLog(key), field }, error as Error);
        return null;
    }
}

/**
 * Set multiple fields on a hash in a single round-trip. The existing
 * `hSet(key, field, value)` wrapper is single-field; this complements it
 * for batch writes (run-group state flushes 5-8 fields per update).
 */
export async function hSetMulti(key: string, fields: Record<string, string>): Promise<number> {
    const client = pickClient(key);
    if (!client) return 0;
    if (Object.keys(fields).length === 0) return 0;
    try {
        return await client.hset(key, fields);
    } catch (error) {
        logger.warn(
            'hSetMulti failed',
            { key: truncateKeyForLog(key), fieldCount: Object.keys(fields).length },
            error as Error,
        );
        return 0;
    }
}

/**
 * Atomic increment for hash field. Used by run-group state to count child-job
 * completions without read-modify-write races when concurrency > 1.
 */
export async function hIncrBy(key: string, field: string, increment: number): Promise<number> {
    // NOTE: do NOT guard on `valkeyClient` here — coordination keys (this is used
    // by run-group state) route to a DIFFERENT client via pickClient(key). Guarding
    // on the default client would silently return 0 on split deployments. The
    // `pickClient(key)` null-check below is the correct guard (as every other
    // wrapper in this file does).
    // HINCRBY (not HINCRBYFLOAT) requires an integer; passing a float would
    // make Valkey reject the command and return 0 here, silently stalling
    // counters. Fail fast for the caller bug.
    if (!Number.isInteger(increment)) {
        logger.warn('hIncrBy called with non-integer increment', {
            key: truncateKeyForLog(key),
            field,
            increment,
        });
        return 0;
    }
    const client = pickClient(key);
    if (!client) return 0;
    try {
        const result = await client.hincrBy(key, field, increment);
        return Number(result);
    } catch (error) {
        logger.warn('hIncrBy failed', { key: truncateKeyForLog(key), field }, error as Error);
        return 0;
    }
}

/**
 * Delete one or more hash fields
 */
export async function hDel(key: string, fields: string | string[]): Promise<number> {
    const client = pickClient(key);
    if (!client) return 0;
    const fieldArray = Array.isArray(fields) ? fields : [fields];
    if (fieldArray.length === 0) return 0;
    try {
        return await client.hdel(key, fieldArray);
    } catch (error) {
        logger.warn('hDel failed', { key: truncateKeyForLog(key) }, error as Error);
        return 0;
    }
}

/**
 * Get all hash fields and values
 */
export async function hGetAll(key: string): Promise<Record<string, string>> {
    const client = pickClient(key);
    if (!client) return {};
    try {
        const result = await client.hgetall(key);
        if (!result) return {};
        const converted: Record<string, string> = {};
        // Glide 9+ returns `Array<{ field: GlideString; value: GlideString }>`.
        // The previous wrapper used `Object.entries(result)` which treated the
        // array's numeric indices as keys, producing `{ '0': '[object Object]', ... }`
        // and silently breaking every reader (getRunGroup, listActiveRunGroups,
        // anything that hGetAll's into a hash).
        // Stay tolerant of both shapes in case Glide flips again or older
        // versions are encountered.
        if (Array.isArray(result)) {
            for (const entry of result as Array<{
                field: unknown;
                value: unknown;
            }>) {
                if (!entry || typeof entry !== 'object') continue;
                const field = glideStringToString(entry.field as never);
                if (!field) continue;
                converted[field] = glideStringToString(entry.value as never) || '';
            }
        } else {
            for (const [k, v] of Object.entries(result)) {
                converted[k] = glideStringToString(v) || '';
            }
        }
        return converted;
    } catch (error) {
        logger.warn('hGetAll failed', { key: truncateKeyForLog(key) }, error as Error);
        return {};
    }
}

/**
 * Delete one or more keys
 */
export async function del(keys: string | string[]): Promise<number> {
    const keyArray = Array.isArray(keys) ? keys : [keys];
    return delAcrossKeyspaces(keyArray, 'del');
}

/**
 * Get keys matching a pattern using SCAN (non-blocking)
 */
export async function getKeysByPattern(pattern: string, limit = 1000): Promise<string[]> {
    warnIfUnroutablePattern(pattern, 'getKeysByPattern');
    const client = pickClient(pattern);
    if (!client) return [];
    try {
        const keys: string[] = [];
        let cursor = '0';

        do {
            // scan() returns [cursor, keys] tuple
            const [nextCursor, scannedKeys] = await client.scan(cursor, {
                match: pattern,
                count: 100,
            });
            cursor = glideStringToString(nextCursor) || '0';
            for (const key of scannedKeys) {
                const keyStr = glideStringToString(key);
                if (keyStr) {
                    keys.push(keyStr);
                    if (keys.length >= limit) break;
                }
            }
        } while (cursor !== '0' && keys.length < limit);

        if (keys.length >= limit) {
            logger.warn('getKeysByPattern hit limit — results may be truncated', {
                pattern: truncateKeyForLog(pattern),
                limit,
                found: keys.length,
            });
        }

        return keys;
    } catch (error) {
        logger.warn(
            'Failed to get keys by pattern',
            { pattern: truncateKeyForLog(pattern) },
            error as Error,
        );
        return [];
    }
}

/**
 * Get keys matching a pattern using SCAN, propagating any failure.
 *
 * Unlike {@link getKeysByPattern}, this NEVER swallows SCAN errors into an
 * empty array. Callers that interpret the absence of keys as a meaningful
 * signal (e.g. cluster liveness enumeration for ghost-job reclaim) MUST use
 * this variant: collapsing a transient Valkey hiccup into `[]` there would
 * be read as "no peers alive" and trigger mass-reclaim of peer-owned work.
 *
 * Throws when Valkey is not connected or when SCAN errors.
 */
export async function scanKeysOrThrow(pattern: string, limit = 1000): Promise<string[]> {
    warnIfUnroutablePattern(pattern, 'scanKeysOrThrow');
    const client = pickClient(pattern);
    if (!client) {
        throw new Error('Valkey not connected — cannot scan keys');
    }
    const keys: string[] = [];
    let cursor = '0';

    do {
        // scan() returns [cursor, keys] tuple
        const [nextCursor, scannedKeys] = await client.scan(cursor, {
            match: pattern,
            count: 100,
        });
        cursor = glideStringToString(nextCursor) || '0';
        for (const key of scannedKeys) {
            const keyStr = glideStringToString(key);
            if (keyStr) {
                keys.push(keyStr);
                if (keys.length >= limit) break;
            }
        }
    } while (cursor !== '0' && keys.length < limit);

    if (keys.length >= limit) {
        logger.warn('scanKeysOrThrow hit limit — results may be truncated', {
            pattern: truncateKeyForLog(pattern),
            limit,
            found: keys.length,
        });
    }

    return keys;
}

/**
 * Delete keys matching a pattern using SCAN (non-blocking)
 */
export async function deleteKeysByPattern(pattern: string, batchSize = 100): Promise<number> {
    warnIfUnroutablePattern(pattern, 'deleteKeysByPattern');
    const client = pickClient(pattern);
    if (!client) return 0;
    try {
        let deletedCount = 0;
        let keysToDelete: string[] = [];
        let cursor = '0';

        do {
            // scan() returns [cursor, keys] tuple
            const [nextCursor, scannedKeys] = await client.scan(cursor, {
                match: pattern,
                count: 100,
            });
            cursor = glideStringToString(nextCursor) || '0';

            for (const key of scannedKeys) {
                const keyStr = glideStringToString(key);
                if (keyStr) {
                    keysToDelete.push(keyStr);
                    if (keysToDelete.length >= batchSize) {
                        deletedCount += await client.del(keysToDelete);
                        keysToDelete = [];
                    }
                }
            }
        } while (cursor !== '0');

        if (keysToDelete.length > 0) {
            deletedCount += await client.del(keysToDelete);
        }

        if (deletedCount > 0) {
            logger.debug('Deleted keys by pattern', {
                pattern: truncateKeyForLog(pattern),
                count: deletedCount,
            });
        }

        return deletedCount;
    } catch (error) {
        logger.warn(
            'Failed to delete keys by pattern',
            { pattern: truncateKeyForLog(pattern) },
            error as Error,
        );
        return 0;
    }
}

// ============================================================================
// Pub/Sub Support for Watch Together
// valkey-glide requires dedicated clients for subscriptions with immutable config
// ============================================================================

/**
 * Publish a message to a channel
 * Note: valkey-glide uses publish(message, channel) - opposite of Redis PUBLISH command
 */
export async function publishMessage(channel: string, message: string): Promise<boolean> {
    // All pub/sub runs on the REQUIRED coordination instance: control-plane
    // channels (task cancel, config changes, auth-cache invalidation, Watch
    // Together, deny buses) must keep working while the disposable cache is
    // down or not configured at all.
    const client = getCoordinationClient();
    if (!client) return false;
    try {
        // valkey-glide API: publish(message, channel) - message comes first!
        await client.publish(message, channel);
        return true;
    } catch (error) {
        logger.warn('Failed to publish message', { channel }, error as Error);
        return false;
    }
}

type ChannelCallback = (message: string) => void;

/**
 * ONE shared pub/sub connection per process. Channels are added and removed on
 * the live connection (SUBSCRIBE / UNSUBSCRIBE, GLIDE >= 2.x) instead of one
 * dedicated client per channel.
 *
 * Why: closing a GLIDE client that holds a subscription ALWAYS makes its Rust
 * core log `pubsub_synchronizer - Failed to subscribe Exact channels: Internal
 * client has been dropped` at ERROR — measured locally against GLIDE 2.5.2
 * with a client closed 6 s after it subscribed. Per-channel clients are closed
 * whenever a per-session channel goes idle (play-session events, watch
 * together, run log tails …), so each teardown printed one ERROR during normal
 * playback (Windows e2e 2026-09-27, 13:18:19). Unsubscribing a channel on the
 * shared connection logs nothing, and the connection itself is only closed at
 * shutdown, after an UNSUBSCRIBE-all, which is also silent.
 */
let subscriber: GlideClient | null = null;
let subscriberPromise: Promise<GlideClient | null> | null = null;
/** The last pub/sub client creation failed (logs the next failure at debug). */
let subscriberCreateFailing = false;

/** Callbacks per channel the shared connection is subscribed to. */
const channelCallbacks = new Map<string, Set<ChannelCallback>>();

/**
 * In-flight SUBSCRIBEs, one per channel, so racing subscribers (several
 * modules subscribe at import time during boot) share one SUBSCRIBE.
 */
const pendingSubscribes = new Map<string, Promise<boolean>>();

/** Pending grace-period UNSUBSCRIBEs, one per channel — see `scheduleUnsubscribe`. */
const unsubscribeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * How long a channel stays subscribed after its last callback left. Covers a
 * page-to-page hop without an UNSUBSCRIBE/SUBSCRIBE round-trip pair.
 */
const SUBSCRIPTION_CLOSE_GRACE_MS = 30_000;

function dispatch(channel: string, payload: string): void {
    const callbacks = channelCallbacks.get(channel);
    if (!callbacks) return;
    for (const cb of callbacks) {
        try {
            cb(payload);
        } catch (error) {
            logger.warn('Error in pub/sub callback', { channel }, error as Error);
        }
    }
}

function getSubscriber(
    config: NonNullable<ReturnType<typeof parseRedisUrl>>,
): Promise<GlideClient | null> {
    if (subscriberPromise) return subscriberPromise;
    subscriberPromise = (async () => {
        try {
            const clientConfig: Parameters<typeof GlideClient.createClient>[0] = {
                addresses: [{ host: config.host, port: config.port }],
                requestTimeout: 10000,
                useTLS: config.tls,
                clientName: 'lumastra-pubsub',
                pubsubSubscriptions: {
                    // Empty at connect: channels are subscribed on demand.
                    channelsAndPatterns: {},
                    callback: (msg) => {
                        const channel =
                            typeof msg.channel === 'string' ? msg.channel : msg.channel.toString();
                        const payload =
                            typeof msg.message === 'string' ? msg.message : msg.message.toString();
                        dispatch(channel, payload);
                    },
                },
            };
            if (config.password) {
                clientConfig.credentials = {
                    username: config.username || 'default',
                    password: config.password,
                };
            }
            const client = await GlideClient.createClient(clientConfig);
            subscriber = client;
            subscriberCreateFailing = false;
            logger.info('Created shared pub/sub client');
            return client;
        } catch (error) {
            // Warn on the first failure of an outage only: subscribers that
            // retry (auth-cache-bus, notification events) would otherwise log a
            // stack trace on every attempt for as long as Valkey is down.
            if (subscriberCreateFailing) {
                logger.debug('Failed to create pub/sub client (still failing)', {
                    error: error instanceof Error ? error.message : String(error),
                });
            } else {
                subscriberCreateFailing = true;
                logger.warn('Failed to create pub/sub client', {}, error as Error);
            }
            // Let the next subscriber retry rather than caching the failure.
            subscriberPromise = null;
            return null;
        }
    })();
    return subscriberPromise;
}

function cancelScheduledUnsubscribe(channel: string): void {
    const timer = unsubscribeTimers.get(channel);
    if (timer === undefined) return;
    clearTimeout(timer);
    unsubscribeTimers.delete(channel);
}

/**
 * UNSUBSCRIBE a channel once it has been callback-less for the grace period.
 * Re-checks on fire, because a subscriber may have arrived meanwhile.
 */
function scheduleUnsubscribe(channel: string): void {
    cancelScheduledUnsubscribe(channel);
    const timer = setTimeout(() => {
        unsubscribeTimers.delete(channel);
        const callbacks = channelCallbacks.get(channel);
        if (!callbacks || callbacks.size > 0) return;
        channelCallbacks.delete(channel);
        const client = subscriber;
        if (!client) return;
        client.unsubscribe(new Set([channel]), 5000).then(
            () => logger.debug('Unsubscribed channel', { channel }),
            (error: unknown) =>
                logger.warn('Error unsubscribing channel', { channel }, error as Error),
        );
    }, SUBSCRIPTION_CLOSE_GRACE_MS);
    // Never hold the process open for a subscription nobody is using.
    timer.unref?.();
    unsubscribeTimers.set(channel, timer);
}

/**
 * Subscribe to a channel on the shared pub/sub connection.
 * Returns a cleanup function to unsubscribe, or null when pub/sub is
 * unavailable (no Valkey configured, connection failed, or worker thread).
 *
 * Main thread only. The worker-isolation sandbox (`tasks/isolation/`) loads the
 * whole server graph, including modules that subscribe at import time; a
 * worker thread opening its own pub/sub connection (the design routes cache
 * access over the port instead) and then exiting dropped it mid-subscribe.
 * Inside a worker this is a no-op that returns null, exactly like "no Valkey
 * configured".
 */
export async function subscribeToChannel(
    channel: string,
    callback: ChannelCallback,
): Promise<(() => Promise<void>) | null> {
    if (!isMainThread) {
        logger.debug('Skipping pub/sub subscription inside a worker thread', { channel });
        return null;
    }

    // Same instance as publishMessage: the coordination/task Valkey.
    const config = parseRedisUrl(TASK_VALKEY_URL, 'TASK_CACHE_URL', 0);
    if (!config) {
        logger.warn('Cannot subscribe: no TASK_CACHE_URL configured', { channel });
        return null;
    }

    if (!channelCallbacks.has(channel)) {
        let pending = pendingSubscribes.get(channel);
        if (!pending) {
            pending = (async () => {
                const client = await getSubscriber(config);
                if (!client) return false;
                try {
                    await client.subscribe(new Set([channel]), 5000);
                    if (!channelCallbacks.has(channel)) channelCallbacks.set(channel, new Set());
                    logger.debug('Subscribed channel', { channel });
                    return true;
                } catch (error) {
                    logger.warn('Failed to subscribe channel', { channel }, error as Error);
                    return false;
                }
            })().finally(() => {
                pendingSubscribes.delete(channel);
            });
            pendingSubscribes.set(channel, pending);
        }
        if (!(await pending)) return null;
    }

    // An UNSUBSCRIBE may be pending from the last cleanup — this is the reuse the
    // grace period exists for.
    cancelScheduledUnsubscribe(channel);
    let callbacks = channelCallbacks.get(channel);
    if (!callbacks) {
        callbacks = new Set();
        channelCallbacks.set(channel, callbacks);
    }
    const subscribed = callbacks;
    subscribed.add(callback);

    return async () => {
        subscribed.delete(callback);
        logger.debug('Removed callback from subscription', {
            channel,
            callbackCount: subscribed.size,
        });
        // Last callback gone: unsubscribe after the grace period, not now.
        if (subscribed.size === 0) scheduleUnsubscribe(channel);
    };
}

/**
 * Live state of one channel on the shared pub/sub connection, for callers that
 * must know whether they can miss messages (`auth-cache-bus.ts`).
 *
 * GLIDE emits no connect/disconnect events: after a connection loss it
 * reconnects on its own and its pub/sub synchronizer re-issues the desired
 * SUBSCRIBEs, silently. Messages published in between are lost. So the only
 * observable signs are (a) a command on the connection failing while it is
 * down, (b) the channel missing from GLIDE's ACTUAL subscriptions, and (c) the
 * server-side connection id (CLIENT ID) changing across the reconnect — a
 * reconnect fast enough to fall between two probes shows up only as (c).
 *
 * Returns null when there is no pub/sub client (never subscribed, worker
 * thread, Valkey not configured) or the connection does not answer within
 * `timeoutMs`. `subscribed` is false while the channel is desired but not
 * (yet) confirmed by the server.
 */
export async function probeChannelSubscription(
    channel: string,
    timeoutMs = 2000,
): Promise<{ subscribed: boolean; connectionId: number } | null> {
    const client = subscriber;
    if (!client) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const probe = (async () => {
            const connectionId = await client.clientId();
            const state = await client.getSubscriptions();
            const exact =
                state.actualSubscriptions[GlideClientConfiguration.PubSubChannelModes.Exact];
            let subscribed = false;
            for (const ch of exact ?? []) {
                if ((typeof ch === 'string' ? ch : ch.toString()) === channel) {
                    subscribed = true;
                    break;
                }
            }
            return { subscribed, connectionId };
        })();
        const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
            timer.unref?.();
        });
        return await Promise.race([probe, timeout]);
    } catch (error) {
        logger.debug('Pub/sub subscription probe failed', {
            channel,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Re-issue SUBSCRIBE for a channel that already has callbacks on the shared
 * connection. `subscribeToChannel` only sends SUBSCRIBE for a channel it does
 * not know yet; GLIDE restores subscriptions after a reconnect by itself, and
 * this is the nudge for when that has not happened. Idempotent on the server.
 * Returns false when there is no client or the SUBSCRIBE failed.
 */
export async function resubscribeChannel(channel: string): Promise<boolean> {
    const client = subscriber;
    if (!client || !channelCallbacks.has(channel)) return false;
    try {
        await client.subscribe(new Set([channel]), 5000);
        return true;
    } catch (error) {
        logger.debug('Pub/sub re-SUBSCRIBE failed', {
            channel,
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}

// ---------------------------------------------------------------------------
// List and counter helpers (used by watch-together seq/replay, rate-limit, etc.)
// ---------------------------------------------------------------------------

/**
 * Atomically increment a counter key and return the new value.
 * Returns 0 on failure (fail-safe for callers that use it as a sequence number).
 */
export async function incr(key: string): Promise<number> {
    const client = pickClient(key);
    if (!client) return 0;
    try {
        return await client.incr(key);
    } catch (error) {
        logger.warn('incr failed', { key: truncateKeyForLog(key) }, error as Error);
        return 0;
    }
}

/**
 * Prepend one or more values to a list and return the resulting list length.
 * Returns 0 on failure.
 */
export async function lPush(key: string, values: string[]): Promise<number> {
    if (values.length === 0) return 0;
    const client = pickClient(key);
    if (!client) return 0;
    try {
        return await client.lpush(key, values);
    } catch (error) {
        logger.warn('lPush failed', { key: truncateKeyForLog(key) }, error as Error);
        return 0;
    }
}

/**
 * Return the elements of a list between `start` and `stop` (inclusive).
 * Returns [] on failure or missing key.
 */
export async function lRange(key: string, start: number, stop: number): Promise<string[]> {
    const client = pickClient(key);
    if (!client) return [];
    try {
        const result = await client.lrange(key, start, stop);
        return result.map((v) =>
            typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString() : String(v),
        );
    } catch (error) {
        logger.warn('lRange failed', { key: truncateKeyForLog(key) }, error as Error);
        return [];
    }
}

/**
 * Trim a list to only contain elements between `start` and `stop` (inclusive).
 */
export async function lTrim(key: string, start: number, stop: number): Promise<void> {
    const client = pickClient(key);
    if (!client) return;
    try {
        await client.ltrim(key, start, stop);
    } catch (error) {
        logger.warn('lTrim failed', { key: truncateKeyForLog(key) }, error as Error);
    }
}

/**
 * Atomically REMOVE and return up to `count` elements from the head of a list.
 * Returns [] on failure or missing key.
 *
 * Use this, not `lRange` + `lTrim`, for a queue with more than one consumer: the
 * two-step form trims by POSITION, so a second consumer that read the same head
 * slice will trim entries it never saw and they are lost silently. LPOP hands each
 * consumer a disjoint batch.
 */
export async function lPopCount(key: string, count: number): Promise<string[]> {
    if (count <= 0) return [];
    const client = pickClient(key);
    if (!client) return [];
    try {
        const result = await client.lpopCount(key, count);
        if (!result) return [];
        return result.map((v) =>
            typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString() : String(v),
        );
    } catch (error) {
        logger.warn('lPopCount failed', { key: truncateKeyForLog(key) }, error as Error);
        return [];
    }
}

/**
 * Return the length of a list. Returns 0 on failure or missing key.
 */
export async function lLen(key: string): Promise<number> {
    const client = pickClient(key);
    if (!client) return 0;
    try {
        return await client.llen(key);
    } catch (error) {
        logger.warn('lLen failed', { key: truncateKeyForLog(key) }, error as Error);
        return 0;
    }
}

/**
 * Close the shared pub/sub connection (graceful shutdown). UNSUBSCRIBEs every
 * channel first: closing a client that still holds subscriptions makes GLIDE's
 * Rust core log `Internal client has been dropped` at ERROR.
 */
export async function closeAllSubscriptions(): Promise<void> {
    silenceGlideLoggerForShutdown();
    for (const timer of unsubscribeTimers.values()) clearTimeout(timer);
    unsubscribeTimers.clear();
    channelCallbacks.clear();
    const client = subscriber;
    subscriber = null;
    subscriberPromise = null;
    if (!client) return;
    try {
        await client.unsubscribe(null, 2000);
    } catch (error) {
        logger.debug('UNSUBSCRIBE-all before close failed', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
    try {
        client.close();
        logger.debug('Closed shared pub/sub client on shutdown');
    } catch (error) {
        logger.warn('Error closing pub/sub client on shutdown', {}, error as Error);
    }
}
