// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { liveTvRouteGate } from '$lib/server/auth/livetv-user-policy.js';
import { withRequestPathCallScope } from '$lib/server/utils/external-request-counter.js';

import { runWithTimelineGrantScope } from '$lib/server/services/playback-timeline-hrefs.js';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { resolveLegacyAdminPath, appendLegacySearch } from '$lib/config/admin-legacy-paths.js';
import {
    config,
    features,
    shouldStartWorkers,
    CACHE_WARMING_ENABLED,
    CACHE_WARM_TRENDING,
    CACHE_WARM_METADATA,
    CACHE_WARM_HERO,
    CACHE_WARM_BROWSE,
    CACHE_WARM_USERS_LIMIT,
    CACHE_WARM_METADATA_LIMIT,
    CACHE_WARM_ACTIVE_DAYS,
    CACHE_WARM_NIGHTLY_HOUR,
} from '$lib/server/config.js';
import { sessionsCacheService } from '$lib/server/services/sessions-cache.service.js';
import { connectionStatus } from '$lib/server/services/connection-status.service.js';
import {
    startCacheWarming,
    startNightlyScheduler,
    stopNightlyScheduler,
} from '$lib/server/cache/warming.js';
import { building, dev } from '$app/environment';
import { assertValkeyEndpointConfiguration } from '$lib/server/config/valkey-endpoints.js';
import { get as getConfigValue } from '$lib/server/config/config.service.js';
import {
    collectAllowedOrigins,
    EMBED_LINK_CONFIG_KEYS,
    type ConfiguredLink,
} from '$lib/server/embed-allowlist.js';
import { base, assets } from '$app/paths';
import { paraglideMiddleware } from '$lib/paraglide/server.js';
import { Logger, type LoggerInstance } from '$lib/server/utils/logger.js';
import { installUpgradeDispatch } from '$lib/server/utils/http-upgrade.js';
import { applyRuntimeOptimizations } from '$lib/server/runtime-optimizations.js';
import { operationMode } from '$lib/server/operation-mode.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { routedPathname } from '$lib/server/auth/routed-pathname.js';
import {
    clearOldGate,
    markOldGate,
    noteCollapsedStatus,
    withRoutePolicyShadow,
} from '$lib/server/auth/route-policy/shadow.js';
import { adminRouteGate } from '$lib/server/auth/admin-route-gate.js';
import { csrfHandle } from '$lib/server/middleware/csrf.js';
import { cookieTransportHandle } from '$lib/server/auth/cookie-transport.js';
import { requestBodyDrainHandle } from '$lib/server/middleware/request-body-drain.js';
import {
    createShutdownGateHandle,
    createWebShutdown,
    drainTimeoutMsFromEnv,
} from '$lib/server/lifecycle/web-shutdown.js';
import {
    createInfrastructureProbe,
    probeTargetsFromEnvironment,
} from '$lib/server/lifecycle/infrastructure-probe.js';
import { immutableAssetFallbackHandle } from '$lib/server/middleware/immutable-asset-fallback.js';
import { sandboxScriptableResponse } from '$lib/server/middleware/scriptable-response-sandbox.js';
import { buildRequestLanguageHint } from './hooks.language.js';
import { runWithRequestLanguage } from '$lib/server/utils/request-language-context.js';
import { warnIfProxyTrustImplicit } from '$lib/server/utils/client-ip.js';
import { warnIfTrustedProxyCoversGateway } from '$lib/server/utils/docker-gateway-trust.js';
import { warnIfMasterKeyFileConflicts } from '$lib/server/crypto/master-key.js';
import { isAnonymousEntityImagePath } from '$lib/server/utils/entity-image-paths.js';
import {
    isAudiobookByteProxyPath,
    isRetiredAudiobookBytePath,
} from '$lib/server/utils/audiobook-stream-paths.js';
import { isPushRichSignedPath } from '$lib/server/utils/push-rich-paths.js';
import { httpRequestDurationSeconds } from '$lib/server/tasks/metrics.js';
import { jellyfinCorsHandle } from '$lib/server/compat/jellyfin-cors';
import { jellyfinResponseObserverHandle } from '$lib/server/compat/jellyfin-response-observer';
import { THEME_COOKIE } from '$lib/shared/theme/theme-model';
import { resolveActiveThemeId, getThemeTokensCss } from '$lib/server/theme/enabled-themes.js';
import { getCustomCssTag, getCustomJsTag } from '$lib/server/theme/custom-code.js';

if (!building && shouldStartWorkers())
    throw new Error(
        'The web server requires WORKER_MODE=disabled and DEDICATED_WORKER=false; remove both from the web container and run background jobs in a separate worker container (command ./start-worker.sh). Upgrade guide: https://lumastra.org/guides/deploy-docker/#upgrading-to-the-dedicated-worker-and-two-valkeys',
    );
if (!building) assertValkeyEndpointConfiguration();

const startupLogger = Logger.for('Startup');
const migrationLogger = Logger.for('Migration');
const serverLogger = Logger.for('Server');

// Grace window applied to the startup play-session cleanup when other replicas
// are alive: sessions heartbeated/polled within this many seconds are still
// being served by a sibling replica and must survive a rolling-deploy boot.
// Must comfortably exceed the client heartbeat cadence (well under a minute).
const STARTUP_SESSION_CRASH_GRACE_SECONDS = 90;

// =============================================================================
// STARTUP VALIDATION
// =============================================================================
// PostgreSQL and Valkey are REQUIRED - app cannot function without them
// Jellyfin is OPTIONAL - app runs in degraded mode if unavailable (allows initial setup)

function validateRequiredConfig(): void {
    const missing: string[] = [];
    const optional: string[] = [];

    // Jellyfin is OPTIONAL - allow initial setup without it
    // Users can configure via admin panel
    if (!config.JELLYFINURL) optional.push('JELLYFINURL');
    if (!config.JELLYFINAPIKEY) optional.push('JELLYFINAPIKEY');

    // The database and the task Valkey are REQUIRED; CACHE_URL (the disposable
    // cache) is optional and best-effort.
    // Use config object which properly loads from $env/dynamic/private
    if (!config.DATABASE_URL) missing.push('DATABASE_URL');
    if (!config.TASK_CACHE_URL) missing.push('TASK_CACHE_URL');

    if (missing.length > 0) {
        startupLogger.error('FATAL: Required configuration missing', undefined, {
            missing,
            help: 'Configure these variables in your .env file or environment',
            examples: {
                DATABASE_URL: 'postgresql://user:pass@localhost:5432/dbname',
                TASK_CACHE_URL: 'redis://default:password@localhost:6379/0',
            },
        });
        process.exit(1);
    }

    if (optional.length > 0) {
        startupLogger.info(
            'Optional Jellyfin connection not configured (not needed to scan or play your files)',
            {
                missing: optional,
                help: 'Only needed to import watch history from a Jellyfin server: set it in the setup wizard, Admin -> Settings, or via environment variables',
            },
        );
    }
}

if (!building) {
    // Apply runtime optimizations early (HTTP agents, connection pooling)
    applyRuntimeOptimizations();

    // Validate config synchronously at startup
    validateRequiredConfig();

    // F1/F32: warn in production when reverse-proxy trust is implicit (no
    // TRUSTED_PROXY_IPS pinned). IP-bound security decisions cannot be enforced
    // against header spoofing until the proxy IP(s) are listed explicitly.
    warnIfProxyTrustImplicit();

    // Linux e2e 2026-09-29: TRUSTED_PROXY_IPS set to the Docker bridge gateway
    // (a host-installed proxy) trusts every process on the host. Warn once;
    // never block startup (the config doctor carries it to the admin banner).
    warnIfTrustedProxyCoversGateway((message, meta) => startupLogger.warn(message, meta));

    // B1 (Windows new-user e2e 2026-09-27): an env LUMASTRA_MASTER_KEY next to a
    // <config>/master.key holding a DIFFERENT key means secrets sealed under the
    // file key silently fail to decrypt. Name the conflict once; never touch the file.
    warnIfMasterKeyFileConflicts((message) => startupLogger.warn(message));
}

/**
 * Verify Jellyfin connection - NON-FATAL if unavailable. The lifecycle module
 * also follows later Jellyfin setting changes in this process (state, client,
 * sessions mirror) and retries an unreachable server on its own.
 */
async function verifyJellyfinConnection(): Promise<void> {
    const { startJellyfinConnectionLifecycle } =
        await import('$lib/server/jellyfin/connection-lifecycle.js');
    await startJellyfinConnectionLifecycle();
}

// Track PostgreSQL connection status
let postgresConnectionVerified = false;

async function verifyPostgresConnection(): Promise<void> {
    if (postgresConnectionVerified) return;

    connectionStatus.setConnecting('postgres');

    try {
        const { testDbConnection } = await import('$lib/server/database/connection.js');
        const isHealthy = await testDbConnection();

        if (!isHealthy) {
            throw new Error('Health check failed - database not responding');
        }

        postgresConnectionVerified = true;
        connectionStatus.setConnected('postgres');
        startupLogger.info('PostgreSQL connection verified');
    } catch (error) {
        const sanitizedUrl = config.DATABASE_URL.replace(/:[^:@]*@/, ':****@');
        const errorMessage = error instanceof Error ? error.message : String(error);
        connectionStatus.setDisconnected('postgres', errorMessage);

        startupLogger.error('FATAL: Cannot connect to PostgreSQL', error as Error, {
            url: sanitizedUrl,
            troubleshooting: [
                'Verify PostgreSQL server is running (docker ps)',
                'Check DATABASE_URL is correct',
                'Verify database credentials are valid',
                'Ensure network/firewall allows the connection',
                'Confirm the database exists',
            ],
        });
        process.exit(1);
    }
}

// Track Valkey connection status
let valkeyConnectionVerified = false;

async function verifyValkeyConnection(): Promise<void> {
    if (valkeyConnectionVerified) return;

    connectionStatus.setConnecting('valkey');

    try {
        const { testValkeyConnection } = await import('$lib/server/cache/valkey.js');
        const isHealthy = await testValkeyConnection();

        if (!isHealthy) {
            throw new Error('Health check failed - Valkey not responding');
        }

        valkeyConnectionVerified = true;
        connectionStatus.setConnected('valkey');
        startupLogger.info('Valkey (Redis) connection verified');

        // Subscribe to cross-replica config-change events so a config save on
        // any node invalidates this replica's in-memory config (best-effort;
        // never blocks startup).
        try {
            const { startConfigChangeSubscriber } =
                await import('$lib/server/config/config.service.js');
            await startConfigChangeSubscriber();
        } catch (subErr) {
            startupLogger.warn('Could not start config-change subscriber', {
                error: subErr instanceof Error ? subErr.message : String(subErr),
            });
        }
    } catch (error) {
        // Structural redaction: a regex on the raw string leaks the tail of a
        // password that contains an unencoded ':' or '@'.
        let sanitizedUrl = '(unparseable TASK_CACHE_URL)';
        try {
            const parsed = new URL(config.TASK_CACHE_URL);
            if (parsed.username) parsed.username = '****';
            if (parsed.password) parsed.password = '****';
            sanitizedUrl = parsed.toString();
        } catch {
            // keep the placeholder; never log the raw value
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        connectionStatus.setDisconnected('valkey', errorMessage);

        startupLogger.error('FATAL: Cannot connect to Valkey (Redis)', error as Error, {
            url: sanitizedUrl,
            troubleshooting: [
                'Verify Valkey/Redis server is running (docker ps)',
                'Check TASK_CACHE_URL is correct (the task Valkey; CACHE_URL is optional)',
                'Verify authentication credentials are valid',
                'Ensure network/firewall allows the connection',
            ],
        });
        process.exit(1);
    }
}

// Auto-migration system
let migrationCompleted = false;
let migrationPromise: Promise<void> | null = null;

async function ensureDatabaseMigration(): Promise<void> {
    // Only run migration once per container lifecycle
    if (migrationCompleted) {
        return;
    }

    // If migration is already in progress, wait for it
    if (migrationPromise) {
        return migrationPromise;
    }

    migrationPromise = performMigration();
    return migrationPromise;
}

async function performMigration(): Promise<void> {
    try {
        migrationLogger.info('Checking database schema...');

        // Dynamic import to avoid loading migration code in development
        const { migrateSchema } = await import('$lib/server/database/migrate-schema.js');

        migrationLogger.info('Running automatic schema migration...');
        await migrateSchema();
        const { syncImageSelectionPolicy } =
            await import('$lib/server/services/image-candidates.service.js');
        const { getDb } = await import('$lib/server/database/connection.js');
        const imageSql = getDb();
        if (imageSql) await syncImageSelectionPolicy(imageSql);

        migrationCompleted = true;
        migrationLogger.info('Automatic migration completed successfully');

        // Load provider config from DB (chain + field authorities)
        try {
            const { loadProviderConfigFromDb } =
                await import('$lib/server/providers/provider-config-loader.js');
            const { aiDbService } = await import('$lib/server/services/database.service.js');
            const sql = await aiDbService.getSql();
            if (sql) {
                await loadProviderConfigFromDb(sql);
                migrationLogger.info('Provider config loaded from DB');
            }
        } catch (providerError) {
            migrationLogger.warn(
                'Could not load provider config from DB — using env var fallback',
                providerError instanceof Error ? providerError : undefined,
            );
        }
    } catch (error) {
        migrationLogger.error('Automatic migration failed', error as Error);

        // Fail fast — rethrow so the rejected migrationPromise propagates to
        // every handler that awaits ensureDatabaseMigration(). This is the
        // in-app counterpart to scripts/startup-migration.ts's fail-fast
        // behavior: the container's CMD should have already failed at
        // startup, but if a deploy bypassed that script (dev mode, direct
        // app launch, etc.) we still don't want to silently serve traffic
        // against a half-applied schema.
        //
        // migrationCompleted intentionally stays false: every subsequent
        // request awaits the rejected migrationPromise and 500s with the
        // original error, making the problem immediately visible.
        throw error;
    }
}

// CORS configuration for Jellyfin integration
// Add your Jellyfin URL to CORS_ALLOWED_ORIGINS (comma-separated). Built per
// request: a module-level copy froze the list at boot, so a saved change needed
// a restart.
function corsAllowedOrigins(): string[] {
    return [
        ...config.CORS_ALLOWED_ORIGINS,
        // Jellyfin dev: strictly development-only. `dev` is NODE_ENV !== 'production',
        // which would also allowlist this localhost origin under test/unset NODE_ENV.
        ...(process.env.NODE_ENV === 'development' ? ['http://localhost:8096'] : []),
    ].filter(Boolean);
}

/**
 * Which methods CORS may use on a path, or null when the path is not CORS-enabled.
 *
 * ## Why this lives here and not in a route's `export const OPTIONS`
 *
 * A CORS preflight is unauthenticated BY DEFINITION — the browser sends
 * `OPTIONS` with no `Authorization` and no cookies, precisely to ask whether the
 * real request is allowed. The `/api/v1/*` backstop below returns 401 for any
 * request without a credential, and it runs BEFORE `resolve(event)`, so a
 * per-route `export const OPTIONS` on a v1 route can never execute: the
 * preflight is rejected before routing. That is exactly what happened when
 * `/api/v1/playback/stream-session` (which did export OPTIONS) became
 * `/api/v1/playback/stream-tokens/{id}` — the handler was not carried over, and
 * re-adding it would not have helped.
 *
 * Answering preflight centrally, ahead of the auth gate, is therefore the only
 * placement that works — and it keeps one policy instead of a per-route copy
 * that drifts the next time a route is renamed.
 */
export function corsAllowedMethods(pathname: string): string | null {
    // Jellyfin-integration surface: read-only.
    if (pathname.startsWith('/api/for-you')) return 'GET, OPTIONS';
    // The public/native API. Third-party browser clients live on another origin,
    // so every non-GET call and every call carrying Authorization preflights.
    if (pathname.startsWith('/api/v1/')) return 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
    return null;
}

/**
 * Request headers a cross-origin caller may send.
 *
 * `Authorization` is the one that matters and the one the retired handler
 * omitted: it is not CORS-safelisted, so a Bearer call preflights and is refused
 * unless it appears here. `Range` likewise — byte-ranged playback
 * (`/api/v1/playback/{id}/file`) is a preflighted request from a browser.
 */
const CORS_ALLOWED_REQUEST_HEADERS = 'Content-Type, Authorization, Range';

/**
 * Response headers a cross-origin caller may READ. Without this the browser
 * hands the app a response whose `Content-Range` it cannot see, which breaks
 * seeking, and hides `Retry-After` on a 429. `Deprecation`, `Sunset` and
 * `Link` carry the deprecation signal of a deprecated operation (api/deprecation.ts).
 */
const CORS_EXPOSED_RESPONSE_HEADERS =
    'Content-Range, Accept-Ranges, Content-Length, Retry-After, X-Lumastra-Auth-Unavailable, X-Lumastra-Auth-Retry, Deprecation, Sunset, Link';

/** Match every image-serving route across all the path prefixes:
 *    /api/image/*           — primary image proxy
 *    /j/**\/Images/*         — Jellyfin compat shim (e.g. /j/Items/<id>/Images/Primary)
 *    /api/v1/media/*\/images/* — entity image endpoints (binary responses)
 * Used to skip i18n + most security headers — none of these serve
 * translatable HTML or apply CSP via <img>. */
export function isImagePath(pathname: string, routeId?: string | null): boolean {
    if (pathname.startsWith('/api/image/')) return true;
    // /j routes match case-insensitively (reroute-pathname.ts), so decide by the
    // matched route, not the spelling: `Images` must be a real route segment, not
    // a param or rest value (`/j/web/images/x`).
    if (pathname.startsWith('/j/')) return /\/Images(\/|$)/.test(routeId ?? '');
    // Entity image endpoints: /api/v1/{media|people|users|libraries}/{id}/images/...
    if (pathname.startsWith('/api/v1/') && pathname.includes('/images/')) return true;
    return false;
}

/**
 * Path prefixes that bypass forward auth and are therefore reachable by
 * unauthenticated callers. Any HTML response on these paths leaks the app
 * shell (branding, layout, JS bundle paths) and lets external probes
 * fingerprint the deployment as a Lumastra.
 *
 * - /j, /j/*     — Jellyfin compat (self-auth via X-Emby-Authorization). The
 *                  bare /j root is included because nginx's `location ^~ /j/`
 *                  auto-redirects unauthenticated requests there before they
 *                  ever reach Authentik — see the `/j` root route.
 * - /api/v1/*    — Unified token API (Bearer / signed URL / stream token), plus
 *                  the task/ops groups that do their own in-handler auth. The
 *                  reverse proxy bypasses Authentik for this whole prefix, so it
 *                  is reachable without forward-auth and must get the same
 *                  anti-fingerprint / no-leak treatment. (Was /public-api/*.)
 * - /oauth/*     — Public OAuth device flow endpoints
 * - /subsonic/*  — OpenSubsonic compat (auth via query params on /rest/*)
 *
 * The post-resolve guard in mainHandle treats responses on these paths
 * specially — see the comments at the call site for the full policy.
 */
function isJellyfinCompatPath(pathname: string): boolean {
    return pathname === '/j' || pathname.startsWith('/j/');
}

function isBypassAuthPath(pathname: string): boolean {
    return (
        isJellyfinCompatPath(pathname) ||
        pathname === '/api/v1' ||
        pathname.startsWith('/api/v1/') ||
        pathname === '/oauth' ||
        pathname.startsWith('/oauth/') ||
        pathname === '/subsonic' ||
        pathname.startsWith('/subsonic/')
    );
}

/**
 * Auth-bearing query parameters that must never reach logs / stdout / log
 * aggregators. Clients pass session tokens / PATs / stream tokens in the URL
 * for HLS playback and AVPlayer sub-requests (which can't set headers), so the
 * raw URL would otherwise leak credentials. Covers both the Jellyfin compat
 * (`/j/*`) and the unified token API (`/api/v1/*`) surfaces.
 */
const SENSITIVE_QUERY_PARAMS = [
    'api_key',
    'ApiKey',
    'token',
    'stream_token',
    'grant',
    'access_token',
    // OAuth link and OIDC callbacks carry credentials and correlation secrets.
    'code',
    'user_code',
    'state',
    'id_token',
    'refresh_token',
    'client_secret',
    // Jellyfin compat / signed-URL credentials. Jellyfin clients may also send
    // their header token as a query parameter.
    'jellyfin_compat',
    'sig',
    'X-Emby-Token',
    'X-MediaBrowser-Token',
    // Subsonic auth params (subsonic-compat/middleware.ts): p = password
    // (`enc:<hex>` or plaintext), t = MD5 token digest, s = salt.
    'p',
    't',
    's',
] as const;

const SENSITIVE_QUERY_PARAM_KEYS: ReadonlySet<string> = new Set(
    SENSITIVE_QUERY_PARAMS.map((k) => k.toLowerCase()),
);

/**
 * Stream tokens that travel as a PATH segment rather than a query parameter.
 *
 * The audiobook byte proxy puts its `stream_…` credential in the path because a
 * manifest's relative `output-N.ts` reference resolves without the query string
 * (see `services/audiobook-stream-auth.ts`). SENSITIVE_QUERY_PARAMS only scrubs
 * the query, so without this the credential would be logged verbatim on every
 * segment request — thousands per book.
 */
const PATH_STREAM_TOKEN_RE = /\/stream_[A-Za-z0-9_-]+/g;

/**
 * Build a log-safe path+query string for a request URL, redacting any
 * credential-bearing query params (see SENSITIVE_QUERY_PARAMS) and any
 * path-carried stream token. Returns just the pathname when there is no query
 * string.
 */
export function logSafePathWithQuery(url: URL): string {
    let path: string = url.pathname.replace(PATH_STREAM_TOKEN_RE, '/<redacted>');
    if (url.search) {
        const sanitized = new URLSearchParams(url.searchParams);
        // Case-insensitive: clients send `ApiKey`, `api_key`, `Code`, `STATE`.
        for (const k of new Set(sanitized.keys())) {
            if (SENSITIVE_QUERY_PARAM_KEYS.has(k.toLowerCase())) sanitized.set(k, '[REDACTED]');
        }
        const qs = sanitized.toString();
        if (qs) path += '?' + qs;
    }
    return path;
}

/**
 * APP-LAYER AUTH BACKSTOP for /api/v1/*.
 *
 * The reverse proxy bypasses Authentik for the entire /api/v1/* prefix (so
 * token clients and AVPlayer signed-URL sub-requests reach the app directly).
 * That removes the proxy-level safety net that used to guarantee a request
 * couldn't reach an admin/ops route unauthenticated. This backstop replaces it
 * at the app layer: any /api/v1/* request that exits `resolveAuth` without an
 * established identity AND isn't a recognized credential-in-URL bypass is
 * rejected 401 here, so a route can never accidentally run unauthenticated.
 *
 * Returns true when the request is allowed to proceed; false ⇒ caller 401s.
 *
 * Allowed to proceed:
 *   - locals.user is set (PAT, svc, JWT, stream-token — the bearer/token paths).
 *   - A Bearer Authorization header is present (a task/ops machine client; the
 *     route's own authenticate() will validate it and 401 if invalid).
 *   - A bypass path carrying its credential in the URL:
 *       - entity image endpoints using HMAC-signed sig parameter;
 *         validated in-route, serves image or 403s.
 *       - Top Shelf preview/cinemagraph MP4s (`/topshelf-preview/file/…`)
 *         using an HMAC-signed sig parameter (purpose 'topshelf-preview');
 *         validated in-route, serves the MP4 or 403s. Scoped to the `/file/`
 *         sub-path ONLY — the mint endpoint (`…/topshelf-preview` without
 *         `/file/`) is NOT covered here and still requires a real
 *         authenticated user.
 *       - The push rich-notification pair (`…/push-image`,
 *         `…/push-content/{locale}`) using an HMAC-signed sig parameter;
 *         validated in-route before any DB read, serves the artwork/text or
 *         403s. Scoped to those two exact shapes — the rest of
 *         `/api/v1/notifications/` still requires a bearer.
 *
 * Exported for tests: this predicate is the whole policy, and the routes it
 * exempts are unreachable in production when it is wrong.
 */
export function isApiV1RequestAuthorized(event: Parameters<Handle>[0]['event']): boolean {
    if (
        event.route?.id === '/api/v1/server' &&
        (event.request.method === 'GET' || event.request.method === 'HEAD')
    ) {
        return true;
    }

    if (event.locals.user) return true;

    const authHeader = event.request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) return true;

    // Routed, not raw: `/de/api/v1/…` and `/api/%76%31/…` reach these routes too.
    const path = routedPathname(event.url);

    // Broad match: /api/v1/*/images/** covers FIVE subtrees under defs/ —
    // media/[id]/images/**, users/[id]/images/**, libraries/[id]/images/**,
    // people/[id]/images/**, music/radio/[id]/images/[role].ts (verified by
    // `find src/lib/server/api/defs -type d -iname images`; the sixth hit,
    // defs/admin/media/[id]/images/**, is admin-only and not dual-mounted
    // under /api/v1/ at all — no src/routes/api/v1/admin/media directory —
    // so it never reaches this predicate).
    //
    // "declares auth:'none' and validates ?sig= in-route" is TRUE for only
    // TWO of the five: media/[id]/images/[role].ts and its
    // [role]/[index].ts (the byte-serving routes — real `auth: {kind:
    // 'public'}`, 'none' is a docs-only display field, `?sig=` is
    // HMAC-verified in-route via verifySignedUrl). It is FALSE for the
    // other four, and none of them validates a signature at all:
    //   - libraries/[id]/images/[role].ts:90, index.ts:96,
    //     [role]/[index].ts:68 — real `auth: { kind: 'user' }`.
    //   - users/[id]/images/** is not exempted at all any more
    //     (isAnonymousEntityImagePath): index.ts and [role].ts GET are
    //     `{kind:'user'}`, [role]/[index].ts GET `{kind:'user'}` and
    //     PUT/DELETE `{kind:'selfOrAdmin', param:'id'}`.
    //   - people/[id]/images/index.ts:75, [role].ts:114,
    //     [role]/[index].ts:80 — real `auth: { kind: 'user' }`.
    //   - music/radio/[id]/images/[role].ts:54 — real `auth: { kind: 'user' }`.
    //   - music/images/collage.ts — `{kind:'public'}`, no `?sig=`; like
    //     media/[id]/images/[role].ts it serves artwork only for the given
    //     UUIDs and drops ids the caller cannot access when a credential is
    //     presented (forward-auth falls through to parse it).
    // (media/[id]/images/index.ts, the roles-LIST endpoint, is also
    // `{kind:'public'}` with no `?sig=` — but it returns no raw bytes, only
    // hrefs/counts, so it needs none; a different shape from the four
    // FALSE entries above, not folded into either claim.)
    //
    // Not a live hole regardless — this is a BACKSTOP, and mount.ts's
    // per-def `enforce()` (:405-409) still runs for every def before its
    // handler body, so a `{kind:'user'}`/`{kind:'selfOrAdmin'}` def 401s
    // here whether or not this predicate exempts its path. But this
    // docstring's own :545-546 says this predicate IS the whole policy and
    // the routes it exempts are unreachable in production when it's wrong,
    // so it must describe what's actually gated — corrected twice already
    // (2026-09-22, final fix wave item 5, then re-review same day) for
    // narrowing/enumeration errors each time; this version was independently
    // re-derived per-subtree rather than restated.
    // User images are excluded (isAnonymousEntityImagePath): they need a credential.
    if (isAnonymousEntityImagePath(path)) return true;

    // Top Shelf preview MP4s declare auth:'public' and validate ?sig= in-route.
    // Scoped to the /file/ sub-path only — the mint endpoint must NOT pass
    // this gate; it requires a real authenticated user.
    if (path.startsWith('/api/v1/media/') && path.includes('/topshelf-preview/file/')) return true;

    // Audiobook byte proxy — the stream token is the credential and is validated
    // in-route (pinned to the {mediaId} in the path, wildcard tokens refused).
    // Needed as its own entry because the HLS sub-path carries the token as a
    // PATH segment, not a query parameter: a manifest's relative `output-N.ts` reference
    // resolves without the query string, so a query-carried token would 401
    // every segment. The predicate is an anchored full-path match shared with
    // forward-auth — a substring test would also exempt any future sibling
    // route reached with a {mediaId} of the literal string "file"/"hls".
    if (isAudiobookByteProxyPath(path)) return true;

    // Retired singular audiobook byte paths (P9): GET and HEAD answer 410 route_retired to
    // anyone and reveal nothing, so they skip the credential requirement. Other methods still
    // need one. The predicate is the anchored full-path match from audiobook-stream-paths.ts.
    if (
        (event.request.method === 'GET' || event.request.method === 'HEAD') &&
        isRetiredAudiobookBytePath(path)
    )
        return true;

    // Push rich-notification pair — the ?sig= HMAC is the credential and is
    // verified in-route before any DB read. An iOS Notification Service
    // Extension holds no usable bearer token, so the Authorization check above
    // can never pass for it. Anchored full-path match (UUID id + known locale)
    // shared with forward-auth — a '/api/v1/notifications/' prefix would also
    // unauthenticate the list, mark-read and preference routes.
    if (isPushRichSignedPath(path)) return true;

    return false;
}

function sanitizedErrorBody(pathname: string): string {
    // Always emit the same envelope regardless of the underlying error.
    // Distinguishing 404 from 500 in the body would still let probes map
    // routing tables ("this path errored — must exist; that path 404'd").
    if (isJellyfinCompatPath(pathname)) {
        return JSON.stringify({ Status: 'NotFound' });
    }
    // The /api/v1 error shape (problem+json), never a hint about the cause.
    return JSON.stringify({ code: 'not_found', error: 'Resource not found', status: 404 });
}

function sanitizedErrorHeaders(pathname: string): Record<string, string> {
    return isJellyfinCompatPath(pathname)
        ? { ...SANITIZED_HEADERS }
        : { ...SANITIZED_HEADERS, 'Content-Type': 'application/problem+json' };
}

// Minimal header set for sanitized error responses on bypass-auth paths.
// Deliberately omits:
//   - Content-Security-Policy (lists TMDB/YouTube hosts → leaks integrations,
//     and browsers don't enforce CSP on application/json anyway)
//   - X-Frame-Options / X-XSS-Protection / Referrer-Policy (no value on JSON)
// Keeps:
//   - Content-Type: required for clients to parse the body
//   - X-Content-Type-Options: nosniff still affects MIME sniffing
//   - Cache-Control: errors must not be cached by intermediaries
const SANITIZED_HEADERS = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
} as const;

// Brandable static-shell logos. app.html renders the navbar logo BEFORE the
// Svelte app hydrates, so it can't read `branding` from page data — it would
// otherwise hardcode the bundled Lumastra assets and ignore an operator's
// APP_LOGO_* config (the visible top-left logo stayed Lumastra regardless of
// branding settings). We replace `%app.*%` placeholders in the shell with the
// configured values via transformPageChunk, falling back to the bundled SVGs.
const DEFAULT_LOGO_SMALL = `${assets}/branding/lumastra-icon.svg`;
const DEFAULT_LOGO_FULL = `${assets}/branding/lumastra-logo-horizontal-ondark.svg`;

/** Mirror $lib/paths `url()`: prefix base path to app-relative ('/...') paths only. */
function withBasePath(path: string): string {
    if (
        !path.startsWith('/') ||
        path.startsWith('//') ||
        (base && path.startsWith(`${base}/`)) ||
        path === base
    ) {
        return path;
    }
    return base ? `${base}${path}` : path;
}

/** Escape a value for safe interpolation into an HTML attribute. */
function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Resolve a configured branding logo path, or fall back to the bundled asset. */
function resolveBrandLogo(configured: string, fallback: string): string {
    return escapeAttr(configured ? withBasePath(configured) : fallback);
}

// Brand strings for the HTML shell, read per response. They were computed once
// at module load on the belief that `config.*` is immutable, but APP_NAME, the
// logos and the theme colour are live settings: a save on the settings page
// kept the old name and logo in the shell until every replica restarted.
function brandStrings(): { logoSmall: string; logoFull: string; name: string; themeColor: string } {
    return {
        logoSmall: resolveBrandLogo(config.APP_LOGO_SMALL, DEFAULT_LOGO_SMALL),
        logoFull: resolveBrandLogo(config.APP_LOGO_FULL, DEFAULT_LOGO_FULL),
        name: escapeAttr(config.APP_NAME),
        themeColor: escapeAttr(config.APP_THEME_COLOR),
    };
}

// Content Security Policy - defense-in-depth against XSS. The directive set is
// static, so the joined header string is built once here at module load; only
// frame-src grows at response time, by the admin-configured embed origins (see
// documentCsp — memoised until the links change). 'unsafe-inline' for scripts/styles
// is required for SvelteKit hydration; can be hardened later with nonces via
// @sveltejs/kit CSP.
const BASE_FRAME_SRC = 'frame-src https://www.youtube.com https://www.youtube-nocookie.com';

export const CSP_DIRECTIVES = [
    "default-src 'self'",
    // Scripts: self + inline (SvelteKit hydration) + blob (workers) + wasm (subtitle renderers) + YouTube iframe API
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://www.youtube.com",
    // Styles: self + inline (Svelte component styles)
    "style-src 'self' 'unsafe-inline'",
    // Images: self + data URIs + external sources (TMDB, Jellyfin proxy, YouTube thumbnails)
    "img-src 'self' data: blob: https://image.tmdb.org https://*.tmdb.org https://i.ytimg.com https://*.ytimg.com",
    // Fonts: self + data URIs
    "font-src 'self' data:",
    // Media: self + blob (HLS segments) + external media servers
    "media-src 'self' blob: data:",
    // Connect: API calls, etc. security review 2026-09-13, C18: `wss:` was
    // dropped — grep confirms zero `new WebSocket(` consumers anywhere in
    // src/ or static/; it was an unused grant. (/j/socket does upgrade now,
    // but only for Jellyfin apps, which this page CSP does not govern.)
    "connect-src 'self' blob: data: https://api.themoviedb.org https://*.tmdb.org",
    // Workers: service worker + blob workers (HLS.js)
    "worker-src 'self' blob:",
    // Child frames: security review 2026-09-13, C18: was `frame-src *`
    // (any origin embeddable). Tightened to the hosts actually embedded —
    // YouTube trailers, both the raw <iframe src="https://www.youtube-nocookie.com/embed/...">
    // tags (RequestModal.svelte, ModalTrailerOverlay.svelte) and the
    // IFrame Player API instances (HeroVideoPlayer.svelte,
    // MediaHoverCard.svelte via createYouTubePlayer, which pins
    // `host: 'https://www.youtube-nocookie.com'`). www.youtube.com is kept
    // alongside nocookie since it's already trusted for the IFrame API
    // script (script-src above) and some API-driven embeds may still
    // render through it. The one OTHER legitimate iframe target —
    // /app/[url], which frames an admin-configured external link — is
    // NOT a fixed host: documentCsp() below appends every configured
    // external-link origin to this directive at response time.
    BASE_FRAME_SRC,
    // Object/embed: block plugins
    "object-src 'none'",
    // Base URI: prevent base tag hijacking
    "base-uri 'self'",
    // Form actions: restrict form submissions
    "form-action 'self'",
    // Frame ancestors: prevent clickjacking (backup for X-Frame-Options)
    "frame-ancestors 'self'",
    // Manifest: PWA manifest from same origin only
    "manifest-src 'self'",
].join('; ');

/**
 * Append the admin-configured embed origins (`/app/[url]` targets) to the base
 * policy's `frame-src`.
 *
 * This has to live in the document-wide policy, not on the `/app/[url]`
 * response: a document's CSP is fixed when it loads, and the dock reaches that
 * route by client-side `goto()`, which fetches only `__data.json`. A per-route
 * header therefore never applied on the first dock click (the frame was
 * blocked until a reload), nor when moving between two embedded origins.
 *
 * An origin carrying a CSP delimiter or whitespace is dropped rather than
 * allowed to smuggle extra directives into the header.
 */
export function withEmbedFrameOrigins(baseCsp: string, origins: Iterable<string>): string {
    const safe = [...origins].filter((o) => /^https?:\/\/[^\s;,'"]+$/.test(o)).sort();
    if (safe.length === 0) return baseCsp;
    return baseCsp.replace(BASE_FRAME_SRC, `${BASE_FRAME_SRC} ${safe.join(' ')}`);
}

// The config lists are replaced (not mutated) on change, so their identities
// key the memo: origins are re-parsed only after an admin edits the links.
let documentCspMemo: { lists: unknown[]; csp: string } | null = null;

export function documentCsp(): string {
    let lists: Array<ConfiguredLink[] | undefined>;
    try {
        lists = EMBED_LINK_CONFIG_KEYS.map((key) =>
            getConfigValue<ConfiguredLink[] | undefined>(key),
        );
    } catch {
        /* expected: config service not initialised yet (early boot) — base policy */
        return CSP_DIRECTIVES;
    }
    if (!documentCspMemo || documentCspMemo.lists.some((list, i) => list !== lists[i])) {
        documentCspMemo = {
            lists,
            csp: withEmbedFrameOrigins(CSP_DIRECTIVES, collectAllowedOrigins(...lists)),
        };
    }
    return documentCspMemo.csp;
}

// security review 2026-09-13, C18: directive names a route is allowed to
// override piecemeal (merged into the full base CSP) rather than owning the
// entire policy verbatim. Keep this list narrow — each entry here is a
// directive where SOME route legitimately needs a different value than the
// global default, but nothing about the rest of the hardened policy
// (script-src, object-src, base-uri, …) should change alongside it.
const MERGEABLE_CSP_DIRECTIVE_NAMES = ['frame-ancestors', 'frame-src'];

/**
 * Merge a route-set `Content-Security-Policy` response header into the full
 * default policy.
 *
 * A route can set its OWN full CSP (any directive not in
 * {@link MERGEABLE_CSP_DIRECTIVE_NAMES} makes the whole header "route-owned"
 * and it is returned verbatim — the route opted into full control). If every
 * directive the route set is one of the mergeable names, each one replaces
 * its counterpart in `baseCsp` and the rest of the hardened default policy
 * (script-src, object-src, base-uri, …) is preserved. With no route CSP at
 * all, `baseCsp` is returned unchanged.
 *
 * Current user: showcase pages set ONLY `frame-ancestors <origins>` to
 * control who can embed THEM (S-4). `/app/[url]` used to set a scoped
 * `frame-src` here too, which never reached a client-side navigation — the
 * embed origins now live in the document-wide policy (withEmbedFrameOrigins).
 */
export function mergeRouteCsp(routeCsp: string | null, baseCsp: string): string {
    if (!routeCsp) return baseCsp;

    const directives = routeCsp
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean);
    const allMergeable =
        directives.length > 0 &&
        directives.every((d) =>
            MERGEABLE_CSP_DIRECTIVE_NAMES.some((name) => d.startsWith(`${name} `)),
        );
    if (!allMergeable) return routeCsp; // route owns the full CSP — preserve verbatim.

    let merged = baseCsp;
    for (const directive of directives) {
        const name = directive.split(' ', 1)[0];
        merged = merged.replace(new RegExp(`${name} [^;]*`), directive);
    }
    return merged;
}

// Bounded set for the Prometheus `method` label (see recordRequestDuration) —
// keeps series cardinality finite against arbitrary client method tokens.
const KNOWN_HTTP_METHODS = new Set([
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
    'TRACE',
    'CONNECT',
]);

// Paraglide i18n middleware
const paraglideHandle: Handle = ({ event, resolve }) => {
    // Skip i18n entirely for image-proxy responses — they have no
    // translatable content and don't render the HTML shell that the
    // %lang% transformPageChunk targets. Avoiding the locale-detection
    // and request-cloning here trims a few ms per image fetch and
    // eliminates an unnecessary Request allocation.
    if (isImagePath(event.url.pathname, event.route.id)) {
        return resolve(event);
    }
    // If FORCE_LOCALE is set, inject it as a cookie to override browser detection
    if (config.FORCE_LOCALE) {
        const forcedLocale = config.FORCE_LOCALE;
        // Create a new request with the PARAGLIDE_LOCALE cookie set
        const headers = new Headers(event.request.headers);
        const existingCookies = headers.get('cookie') || '';
        // Remove any existing PARAGLIDE_LOCALE cookie and add the forced one
        const filteredCookies = existingCookies
            .split(';')
            .map((c) => c.trim())
            .filter((c) => !c.startsWith('PARAGLIDE_LOCALE='))
            .join('; ');
        const newCookies = filteredCookies
            ? `${filteredCookies}; PARAGLIDE_LOCALE=${forcedLocale}`
            : `PARAGLIDE_LOCALE=${forcedLocale}`;
        headers.set('cookie', newCookies);
        event.request = new Request(event.request.url, {
            method: event.request.method,
            headers,
            body: event.request.body,
            // @ts-expect-error - duplex is required for requests with body
            duplex: 'half',
        });
    }

    // Resolve the active theme (cookie → configured default → 'warp') and the
    // generated per-theme token stylesheet. The token CSS is identical for every
    // request (it carries ALL enabled themes) and is cached module-level in
    // getThemeTokensCss(); only the active data-theme id varies per request. The
    // id is always a validated, enabled theme id, so it is safe to inline into
    // both the attribute and the CSS selectors without escaping.
    const themeId = resolveActiveThemeId(event.cookies.get(THEME_COOKIE));
    const themeTokens = getThemeTokensCss();
    // Admin custom CSS rides the same head placeholder, injected AFTER the
    // theme tokens so it can override them. Both custom tags are pre-hardened
    // ('</style' stripped / '</script' escaped) and cached in
    // $lib/server/theme/custom-code with the same config-state invalidation as
    // the theme tokens. Admin-trust feature: no other sanitization.
    const themeStyle =
        (themeTokens ? `<style id="theme-tokens">${themeTokens}</style>` : '') + getCustomCssTag();
    const customJsTag = getCustomJsTag();

    return paraglideMiddleware(event.request, ({ request: localizedRequest, locale }) => {
        event.request = localizedRequest;
        const brand = brandStrings();
        return resolve(event, {
            // NOTE: the theme/custom-code replacements use FUNCTION replacers —
            // admin-supplied CSS/JS may legitimately contain `$&`/`$'`-style
            // sequences that a plain string replacement would interpret as
            // substitution patterns and corrupt.
            transformPageChunk: ({ html }) =>
                html
                    .replace('%lang%', locale)
                    .replace('%theme%', themeId)
                    .replace('%theme.tokens%', () => themeStyle)
                    // Custom JS goes as late as possible: immediately before the
                    // closing </body> of the shell (no-op on chunks without it,
                    // and when no custom JS is configured).
                    .replace('</body>', () => `${customJsTag}</body>`)
                    .replaceAll('%app.logoSmall%', brand.logoSmall)
                    .replaceAll('%app.logoFull%', brand.logoFull)
                    .replaceAll('%app.name%', brand.name)
                    .replaceAll('%app.themeColor%', brand.themeColor),
        });
    });
};

// Main application handle
const mainHandle: Handle = async ({ event, resolve }) => {
    const requestStartedAt = performance.now();

    /** Record HTTP request duration into the Prometheus histogram. */
    const recordRequestDuration = (status: number): void => {
        const durationSeconds = (performance.now() - requestStartedAt) / 1000;
        // Bucket the method to a known set — a client can send an arbitrary
        // method token, and an unbounded `method` label would explode Prometheus
        // series cardinality (same reason `route` uses event.route?.id, not the
        // raw pathname).
        const m = event.request.method.toUpperCase();
        const method = KNOWN_HTTP_METHODS.has(m) ? m : '_other';
        httpRequestDurationSeconds.observe(
            {
                route: event.route?.id ?? '_unknown',
                method,
                status: String(status),
            },
            durationSeconds,
        );
    };

    const origin = event.request.headers.get('origin');
    const isCorsPreflight = event.request.method === 'OPTIONS';
    const isCorsRequest = origin !== null && corsAllowedOrigins().includes(origin);
    // The ROUTED path: these surface checks must agree with the route that
    // answers, or `/de/api/v1/…` gets /api/v1 auth but page headers and CORS.
    const routedPath = routedPathname(event.url);
    const corsMethods = corsAllowedMethods(routedPath);

    // Answer the CORS preflight BEFORE auth — see corsAllowedMethods() for why a
    // per-route OPTIONS handler cannot do this on /api/v1.
    //
    // Still gated on CORS_ALLOWED_ORIGINS rather than `*`: these surfaces are
    // credentialed, and `Access-Control-Allow-Origin: *` may not be combined
    // with credentials at all. An origin the operator has not allowlisted gets
    // no preflight answer and the browser blocks the call, which is the
    // behaviour we want.
    if (isCorsPreflight && isCorsRequest && corsMethods) {
        recordRequestDuration(204);
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': origin,
                'Access-Control-Allow-Methods': corsMethods,
                'Access-Control-Allow-Headers': CORS_ALLOWED_REQUEST_HEADERS,
                'Access-Control-Expose-Headers': CORS_EXPOSED_RESPONSE_HEADERS,
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Max-Age': '86400',
                // The answer depends on the request's Origin, so it must never be
                // reused from a shared cache for a different one.
                Vary: 'Origin',
            },
        });
    }

    /**
     * Stamp the CORS grant onto a response (or a header bag) that this handler is
     * about to return.
     *
     * Several rejections leave `handle` BEFORE `resolve()` — forward-auth's own
     * 401, and the /api/v1 auth backstop — so decorating only the resolved
     * response silently drops the grant on exactly the replies a browser most
     * needs to read. Without it the fetch fails as an opaque CORS error and
     * "your token expired" reaches the client app as "network error".
     */
    function applyCorsGrant(target: Headers | Record<string, string>): void {
        if (!isCorsRequest || !corsMethods || !origin) return;
        if (target instanceof Headers) {
            target.set('Access-Control-Allow-Origin', origin);
            target.set('Access-Control-Allow-Credentials', 'true');
            target.set('Access-Control-Expose-Headers', CORS_EXPOSED_RESPONSE_HEADERS);
            target.append('Vary', 'Origin');
            return;
        }
        target['Access-Control-Allow-Origin'] = origin;
        target['Access-Control-Allow-Credentials'] = 'true';
        target['Access-Control-Expose-Headers'] = CORS_EXPOSED_RESPONSE_HEADERS;
        target['Vary'] = 'Origin';
    }

    // =============================================================================
    // PATH-BASED AUTHENTICATION (delegated to forward-auth middleware)
    // =============================================================================
    markOldGate(event, 'resolveAuth');
    const authResponse = await resolveAuth(event, ensureDatabaseMigration, migrationCompleted);
    if (authResponse) {
        applyCorsGrant(authResponse.headers);
        recordRequestDuration(authResponse.status);
        return authResponse;
    }

    clearOldGate(event);

    const liveTvDenied = liveTvRouteGate(event);
    if (liveTvDenied) return liveTvDenied;

    // APP-LAYER BACKSTOP: the proxy bypasses Authentik for all of /api/v1/*, so
    // there is no longer a proxy-level guarantee that admin/ops routes can't be
    // reached unauthenticated. Reject any /api/v1/* request that exited
    // resolveAuth without an identity AND isn't a credential-in-URL bypass —
    // a route must never accidentally run unauthenticated. The JSON envelope is
    // intentionally generic (the bypass-path anti-fingerprint guard below would
    // collapse it anyway). See isApiV1RequestAuthorized for the full policy.
    if (
        (routedPath === '/api/v1' || routedPath.startsWith('/api/v1/')) &&
        !isApiV1RequestAuthorized(event)
    ) {
        markOldGate(event, 'v1-backstop');
        recordRequestDuration(401);
        const headers: Record<string, string> = {
            ...SANITIZED_HEADERS,
            'Content-Type': 'application/problem+json',
        };
        applyCorsGrant(headers);
        return new Response(
            JSON.stringify({ code: 'unauthorized', error: 'Authentication required', status: 401 }),
            { status: 401, headers },
        );
    }

    // APP-LAYER BACKSTOP: the entire /api/admin/* tree is admin-only by design
    // (every route wraps requireAdmin / createCrudEndpoints). resolveAuth has
    // already populated event.locals.user for these paths (or short-circuited
    // with a 401/redirect when no identity), so by the time we get here an
    // authenticated-but-non-admin caller is the only remaining case. Reject it
    // with a 403 here so a route that ever forgets its own requireAdmin wrapper
    // fails closed for the whole admin surface rather than leaking. This is
    // defense-in-depth — the per-route requireAdmin remains the primary gate.
    //
    // Bearer exception (P0 fix): admin-scoped PAT/svc tokens are a valid admin
    // credential on /api/admin/* even though resolveAuth doesn't populate
    // event.locals.user for them (the forward-auth path has no Bearer handler).
    // Pass Bearer-carrying requests through to the route's own gate — NOT only
    // requireAdmin(): `mount.ts`'s {kind:'admin'} TERTIARY fallback reaches
    // the same requests too, and so does the {kind:'scope'} fallback
    // (`tasks/api-auth.ts`'s `authenticate()`) — a Bearer-only /api/admin
    // scope-def request DOES go through THIS carve-out (its `hasBearer` check
    // below is exactly what keeps such a request from 403ing here before it
    // ever reaches the route). What it does NOT do is resolve identity
    // through `resolveBearerAdminPrincipal()` — `authenticate()` resolves the
    // credential itself via `token-identity.ts` directly, the same shared
    // producer, just not through that specific wrapper. requireAdmin() and
    // the TERTIARY fallback both resolve the credential via the SAME shared
    // `resolve-bearer-principal.ts`'s `resolveBearerAdminPrincipal()`, which
    // in turn calls the SAME `$lib/server/auth/token-identity.ts` producer
    // this file's /api/v1 handling relies on (fix-plan-5 Task 3) — so those
    // two arms can no longer disagree on the SAME credential (security review
    // 5, C1/C2). An invalid/non-admin Bearer token still gets 403 from
    // whichever gate.
    //
    // Gated on `features.deviceAuth` (fix-plan-5 Task 4 review, fix round 1,
    // Important 2): forward-auth.ts's own Bearer exception was gated on this
    // flag, but this SEPARATE carve-out was not — a request carrying BOTH a
    // valid non-admin session (so resolveAuth never 401s it) AND an
    // admin-scoped Bearer header reaches this backstop with
    // `event.locals.user?.isAdmin` false, and without this gate `hasBearer`
    // would still let it through to `resolveBearerAdminPrincipal()` (itself
    // now ALSO gated on the same flag — see that file — so this is
    // defense-in-depth, not the only gate).
    const hasBearer =
        features.deviceAuth &&
        !!event.request.headers.get('authorization')?.match(/^bearer[ \t]+\S/i);
    // /admin page routes: a form ACTION runs before any load, so a non-admin POST
    // to /admin/…?/save reached the handler unchallenged (security review
    // 2026-09-12, C4/C5) — mutating requests get a 403 here.
    //
    // GET/HEAD are gated here too, NOT only by the admin layout's `load`
    // redirect: a client data request (`/admin/…/__data.json?x-sveltekit-invalidated=001`)
    // marks the layout node as not invalidated, SvelteKit skips its load, and
    // only the page's load runs. A non-admin got every page load that does not
    // re-check isAdmin itself (e.g. the full /admin/settings config payload).
    // A redirect thrown here becomes `{"type":"redirect"}` for data requests and
    // a 303 for documents — the same UX the layout gives.
    // The decision itself lives in admin-route-gate.ts (matched on `event.route.id`,
    // so `/%61dmin/…` and a subfolder base path are gated too); its unit test
    // sweeps every route id under /admin and /api/admin.
    markOldGate(event, 'admin-gate');
    const adminGateResponse = adminRouteGate(event, {
        hasBearer,
        headers: SANITIZED_HEADERS,
        onReject: recordRequestDuration,
    });
    if (adminGateResponse) return adminGateResponse;
    clearOldGate(event);

    // Resolve the request. transformPageChunk runs only when SvelteKit renders a
    // page (or its error page), before the Response exists, so it marks pages
    // in a way no endpoint or proxied upstream header can imitate.
    let renderedPage = false;
    const response = await resolve(event, {
        transformPageChunk: ({ html }) => {
            renderedPage = true;
            return html;
        },
    });

    // The preflight only grants permission; the browser still refuses to hand the
    // body to the caller unless the ACTUAL response repeats the grant.
    //
    // Applied HERE, immediately after resolve(), rather than at the end of the
    // handler: `/api/v1/*` is a bypass-auth path, and the non-HTML branch of that
    // block returns early, so a v1 response never reached a tail-end version of
    // this. It answered the preflight and then dropped the header off the request
    // the preflight had just authorised — the browser blocks that just as firmly.
    applyCorsGrant(response.headers);

    // Before any early return below: the image and bypass branches skip the
    // document CSP, and an endpoint body whose type comes from a file or a
    // provider (MKV attachment, artwork, sidecar) opened as a page would
    // otherwise run script on our origin. Pages keep the document CSP.
    sandboxScriptableResponse(response, event.route.id, renderedPage);

    // Log /j/ requests for Jellyfin compat debugging: failures at warn, the
    // rest at debug. Successes were info — ~2,000 lines an hour from one
    // Android TV client on prod, one per HLS segment while it plays, which
    // buried everything else at the default log level.
    // Strip auth-bearing query params (grant, api_key, ApiKey, token, stream_token,
    // access_token) before logging — Jellyfin clients pass session tokens /
    // PATs in URL for HLS playback, and the raw URL would otherwise leak
    // credentials to stdout / log aggregators / Docker journals.
    if (isJellyfinCompatPath(routedPath)) {
        const method = event.request.method;
        const path = logSafePathWithQuery(event.url);
        if (response.status >= 400) {
            serverLogger.warn(`Jellyfin compat ${response.status}`, {
                method,
                path,
            });
        } else {
            serverLogger.debug(`Jellyfin compat ${response.status}`, {
                method,
                path,
            });
        }
    }

    // Image responses are binary payloads with image/* content types —
    // browsers don't apply CSP, X-Frame-Options, X-XSS-Protection, or
    // Referrer-Policy to <img> requests, so attaching ~700 bytes of
    // security headers to every image response is wasted bytes. Keep
    // X-Content-Type-Options because nosniff still affects sniffing of
    // unexpected MIME types on <img>. Skip the rest.
    //
    // Covers /api/image/, /api/v1/*/images/*, and /j/.../Images/ — all
    // serve image bytes; the pattern also covers entity image endpoints
    // (/api/v1/media/{id}/images/{role}) and the Jellyfin compat shim.
    if (isImagePath(routedPath, event.route.id)) {
        response.headers.set('X-Content-Type-Options', 'nosniff');
        // CORS for /api/for-you (handled below) doesn't apply to images.
        recordRequestDuration(response.status);
        return response;
    }

    // Anti-fingerprinting / no-leak guard for unauthenticated path prefixes.
    //
    // /j/, /api/v1/, /oauth/, /subsonic/ are reachable without forward
    // auth, so probes from anywhere on the public internet can hit them.
    // Two failure modes need handling:
    //
    //   (1) HTML error page renders (SvelteKit's default +error.svelte for
    //       thrown errors / unhandled exceptions). This leaks the app name,
    //       Star Trek error quotes, full layout, hashed JS bundle paths.
    //       → Replace with a minimal 404 JSON envelope. Status is collapsed
    //         to 404 across the board so probes can't distinguish "route
    //         exists but errored" from "route doesn't exist". Server-side
    //         error logging still sees the original status.
    //         Gated on status >= 400 so legitimate 200 HTML responses (e.g.
    //         /j/web/* — the Jellyfin client-deeplink redirect shim) pass
    //         through unchanged.
    //
    //   (2) Successful non-HTML responses (200 JSON, HLS, etc.) currently
    //       receive the verbose security-header block below, including a
    //       CSP that lists TMDB and YouTube hosts — a clear integration
    //       fingerprint. Browsers don't enforce CSP / X-Frame-Options /
    //       X-XSS-Protection on JSON or HLS, so those headers are pure
    //       overhead and pure fingerprint. Strip them; keep nosniff +
    //       Referrer-Policy which still apply.
    if (isBypassAuthPath(routedPath)) {
        const ctype = response.headers.get('content-type') ?? '';
        const isHtml = ctype.startsWith('text/html');

        if (isHtml && response.status >= 400) {
            noteCollapsedStatus(event, response.status);
            // (1) Sanitize HTML error → minimal 404 JSON.
            recordRequestDuration(404);
            return new Response(sanitizedErrorBody(routedPath), {
                status: 404,
                headers: sanitizedErrorHeaders(routedPath),
            });
        }

        if (!isHtml) {
            // (2) Non-HTML response on a bypass path → strip CSP/XFO/XSS,
            //     keep just the headers that meaningfully apply.
            response.headers.set('X-Content-Type-Options', 'nosniff');
            response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
            recordRequestDuration(response.status);
            return response;
        }
        // Successful HTML response on a bypass path (e.g. /j/web/*) falls
        // through to the standard security-header block — the Jellyfin
        // client deeplink shim is HTML and benefits from CSP enforcement.
    }

    // Add security headers to all responses
    // These help prevent common web vulnerabilities
    response.headers.set('X-Content-Type-Options', 'nosniff');
    // Preserve route-set X-Frame-Options (e.g. showcase sets DENY or omits it for embed).
    // Only apply the global SAMEORIGIN default when the route did not set its own value.
    if (!response.headers.has('X-Frame-Options')) {
        response.headers.set('X-Frame-Options', 'SAMEORIGIN');
    }
    response.headers.set('X-XSS-Protection', '1; mode=block');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Content Security Policy - defense-in-depth against XSS. documentCsp() is
    // the static CSP_DIRECTIVES with the admin-configured embed origins in
    // frame-src, memoised; only a route-set merge below allocates a new string.

    // S-4 / C18: merge a route-set frame-ancestors and/or frame-src into the
    // full CSP directive set (see mergeRouteCsp's doc comment). Showcase pages
    // set ONLY frame-ancestors (to control who can embed THEM). Previously we skipped the global CSP entirely when the route
    // set any CSP, leaving those pages without script-src/object-src/base-uri
    // hardening. A route that sets any OTHER directive owns the full CSP and
    // is preserved verbatim.
    response.headers.set(
        'Content-Security-Policy',
        mergeRouteCsp(response.headers.get('Content-Security-Policy'), documentCsp()),
    );

    // Disable HTTP caching on SSR'd HTML responses by default. Every page in
    // this app is authenticated and renders user-specific state (watch state,
    // ratings, dismissals, recommendations, …). Without an explicit
    // Cache-Control, browsers apply heuristic caching (RFC 7234) and may
    // serve a stale body on the next reload — that broke the watch page's
    // post-mark-watched defensive cache-clear (see the localStorage resume
    // backup design). Routes that genuinely want shared/long-lived caching
    // can still opt in via `setHeaders({ 'cache-control': '…' })` in their
    // load function — the per-route value is preserved here.
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.startsWith('text/html') && !response.headers.has('cache-control')) {
        response.headers.set('Cache-Control', 'no-store');
    }

    recordRequestDuration(response.status);
    return response;
};

// Combine handles: CSRF origin guard first (reject forged cross-site form posts
// before any auth resolution or side effect), then the immutable-asset-history
// fallback (serves previous builds' hashed chunks to stale open tabs), then
// paraglide for i18n, then the main app logic.
/**
 * Admin IA legacy-path redirects (src/lib/config/admin-legacy-paths.ts): the
 * redesign moved dozens of admin routes and later deleted the temporary stub
 * pages that forwarded old bookmarks. This MUST live in hooks, not the admin
 * layout load — a dead legacy URL has no matching route, so SvelteKit 404s
 * before any layout load runs. Auth is unaffected: every redirect target is
 * itself admin-gated. appendLegacySearch merges the incoming ?query with a
 * target that may carry its own ?query and/or #anchor.
 */
const adminLegacyRedirectHandle: Handle = ({ event, resolve }) => {
    if (event.url.pathname.startsWith('/admin')) {
        const legacyTarget = resolveLegacyAdminPath(event.url.pathname);
        if (legacyTarget) {
            redirect(308, appendLegacySearch(legacyTarget, event.url.search));
        }
    }
    return resolve(event);
};

// Captures raw language signals (PARAGLIDE_LOCALE cookie / Accept-Language) into
// request-scoped async storage, so the ~30 metadata-overlay call sites can
// negotiate against the ADMIN-ENABLED METADATA SET rather than Paraglide's UI
// locale set. Must run before paraglideHandle: it reads event.cookies, which is
// parsed from the ORIGINAL request, before paraglideHandle rewrites event.request.
// Also opens the request scope in which a grant-authenticated request records its
// grant, so timeline hrefs built later in the request carry it (playback package 8).
const requestLanguageHandle: Handle = ({ event, resolve }) => {
    if (isImagePath(event.url.pathname, event.route.id)) return resolve(event);
    return runWithTimelineGrantScope(() =>
        runWithRequestLanguage(buildRequestLanguageHint(event), () => resolve(event)),
    );
};

/**
 * Drops the `Link` header SvelteKit puts on every SSR page. It lists every
 * CSS/JS chunk the page needs (212 entries, ~15 KB on the home page by
 * 2026-09), which is past the default upstream-header buffer of most reverse
 * proxies: stock nginx (4-8 KB) and HAProxy (~15 KB) answer 502 instead of
 * the page. Nothing is lost: SvelteKit writes every one of those entries into
 * <head> as well (modulepreload, stylesheet and font preload tags), and we
 * send no 103 Early Hints, so the header only arrives with the HTML anyway.
 * Scoped to page renders (`x-sveltekit-page`) so an endpoint that sets its
 * own `Link` (e.g. RFC 8288 pagination) keeps it.
 *
 * Exported for tests.
 */
export function stripPagePreloadLinkHeader(response: Response): Response {
    if (!response.headers.has('link') || response.headers.get('x-sveltekit-page') !== 'true') {
        return response;
    }
    try {
        response.headers.delete('link');
        return response;
    } catch {
        // Immutable headers (a Response passed through from fetch): copy it.
        const copy = new Response(response.body, response);
        copy.headers.delete('link');
        return copy;
    }
}

const shutdownGateHandle = createShutdownGateHandle({
    onRewrittenError: (status, pathname, error) =>
        serverLogger.warn(
            'Answered 503 shutting_down instead of an error after the services stopped',
            { status, pathname },
            error instanceof Error ? error : undefined,
        ),
    // The refusal leaves before mainHandle, which stamps the CORS grant: without
    // it an allowlisted browser origin reads the 503 as an opaque network error.
    decorate: (event, headers) => {
        const origin = event.request.headers.get('origin');
        if (!origin || !corsAllowedOrigins().includes(origin)) return;
        if (!corsAllowedMethods(routedPathname(event.url))) return;
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Credentials', 'true');
        headers.set('Access-Control-Expose-Headers', CORS_EXPOSED_RESPONSE_HEADERS);
        headers.append('Vary', 'Origin');
    },
});

const preloadLinkHeaderHandle: Handle = async ({ event, resolve }) =>
    stripPagePreloadLinkHeader(await resolve(event));

export const handle = sequence(
    ({ event, resolve }) => withRequestPathCallScope(() => resolve(event)),
    // Outermost, so an early answer from any handle or route (413, 401, a CSRF
    // 403) that left the request body unread can't poison a keep-alive socket.
    requestBodyDrainHandle,
    // Before every handle that can set or clear a cookie: Secure follows the
    // protocol the browser used, so sign-in works over plain HTTP on the LAN.
    cookieTransportHandle,
    jellyfinCorsHandle,
    // Once SIGTERM arrived: new requests get 503 shutting_down + Retry-After,
    // in-flight ones are counted until they finish (shutdown waits for them).
    shutdownGateHandle,
    // Sees the final response of every other handle.
    preloadLinkHeaderHandle,
    csrfHandle,
    immutableAssetFallbackHandle,
    adminLegacyRedirectHandle,
    requestLanguageHandle,
    paraglideHandle,
    jellyfinResponseObserverHandle,
    // Route policy table, shadow mode (ROUTE_POLICY_MODE=shadow): logs where the
    // table disagrees with the gates in mainHandle; never changes a response.
    withRoutePolicyShadow(mainHandle, {
        isApiV1RequestAuthorized,
        deviceAuthEnabled: () => features.deviceAuth,
    }),
);

// Framework-level safety net for uncaught errors in load functions and any
// endpoint not covered by withErrorHandler. Logs structured context and returns
// a sanitized client message so internal details never reach the browser.
export const handleError: HandleServerError = ({ error, event, status, message }) => {
    const errorId = crypto.randomUUID();
    const context = {
        errorId,
        routeId: event.route?.id ?? null,
        method: event.request.method,
        status,
        userId: event.locals.user?.userId ?? null,
        principalId: event.locals.principal?.userId ?? null,
    };
    // 4xx "not found"/client routing errors (e.g. a missing static asset) are
    // expected client-driven noise, not server failures: log them without a
    // stack trace so real errors are not buried. Anything 5xx (or with no
    // numeric status at all) keeps the full error-level log with stack.
    if (typeof status === 'number' && status >= 400 && status < 500) {
        serverLogger.debug('Client error', context);
    } else {
        serverLogger.error(
            'Unhandled server error',
            error instanceof Error ? error : new Error(String(error)),
            context,
        );
    }
    return { message: message ?? 'An unexpected error occurred', errorId };
};

// Release advisory locks held by this connection on startup/shutdown.
// Advisory locks are session-scoped — they auto-release when the holding connection closes.
// After a crash, PostgreSQL detects the dead connection and releases its locks.
// We only release locks on our OWN connection here; we never terminate other backends.
async function releaseAllAdvisoryLocks() {
    try {
        startupLogger.info('Releasing advisory locks on current connection...');
        const { testDbConnection, Database } = await import('$lib/server/database/connection.js');

        // Check if AI database is available
        const aiHealthy = await testDbConnection();
        if (!aiHealthy) {
            startupLogger.info('AI database not available, skipping lock cleanup');
            return;
        }

        const db = new Database();
        const sql = db.getSql();

        // Release all advisory locks held by THIS connection only.
        // This is safe: pg_advisory_unlock_all() only affects the calling session.
        await sql`SELECT pg_advisory_unlock_all()`;

        startupLogger.info('Released advisory locks on current connection');

        // Log any remaining advisory locks for visibility (but do NOT terminate them)
        const lockedConnections = await sql<{ pid: number; classid: number; objid: number }[]>`
            SELECT DISTINCT pid, classid, objid
            FROM pg_locks
            WHERE locktype = 'advisory'
              AND granted = true
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND pid != pg_backend_pid()
        `;

        if (lockedConnections.length > 0) {
            startupLogger.info(
                'Other connections still hold advisory locks (will release on their own disconnect)',
                {
                    count: lockedConnections.length,
                    pids: lockedConnections.map((c) => c.pid),
                },
            );
        }
    } catch (error) {
        startupLogger.warn('Could not release advisory locks (non-critical)', {
            error: String(error),
        });
    }
}

// Verify all required connections before starting any services
// PostgreSQL and Valkey are REQUIRED - app exits if unavailable
// Jellyfin is OPTIONAL - app runs in degraded mode if unavailable
async function verifyAllConnections(): Promise<void> {
    // Verify REQUIRED connections first - fail fast if any are unavailable
    await verifyPostgresConnection();
    await verifyValkeyConnection();

    startupLogger.info('Core services verified (PostgreSQL, Valkey)');

    // Verify OPTIONAL Jellyfin connection
    // When jellyfinSync is disabled, run fire-and-forget (don't block startup)
    if (features.jellyfinSync) {
        await verifyJellyfinConnection();
    } else {
        void verifyJellyfinConnection().catch((error: unknown) => {
            startupLogger.warn('Jellyfin connection check failed to start', {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }

    if (connectionStatus.isJellyfinAvailable()) {
        startupLogger.info('All connections verified - full functionality available');
    } else if (operationMode.isJellyfinEnabled) {
        startupLogger.info('Running with Jellyfin connection pending');
    } else {
        startupLogger.info('Running in SETUP MODE - Jellyfin not configured', {
            help: 'Configure Jellyfin via admin panel or environment variables',
        });
    }
}

if (!building) {
    verifyAllConnections().catch((error) => {
        // Errors already logged in individual verification functions
        startupLogger.error('Startup failed', error instanceof Error ? error : undefined);
        process.exit(1);
    });

    // Mark in-flight play sessions as CRASHED on startup so they stop counting
    // against the concurrent-stream limit. On a single node every in-flight
    // session is genuinely orphaned after a restart. In a multi-replica
    // deployment, though, a booting replica must NOT crash sessions a sibling
    // replica is still serving during a rolling deploy — so when live peers
    // exist we only crash sessions with no recent heartbeat/poll (the periodic
    // stale reaper handles the rest). Candidates that already crossed the
    // completion threshold are finalized as COMPLETED first — see
    // reapBootOrphanSessions.
    void import('$lib/server/services/database.service.js')
        .then(async ({ aiDbService }) => {
            const sql = await aiDbService.getSql();
            if (sql) {
                // Determine whether other replicas are alive. getLiveInstanceIds
                // always includes self, so size > 1 means peers exist. Requires
                // Valkey; if it's unavailable the set collapses to just self →
                // grace 0 → legacy crash-all (correct for the single-node case
                // this degrades to). connectValkey is idempotent.
                let graceSeconds = 0;
                try {
                    // Bound the probe: a hung Valkey connect/SCAN must not block
                    // the session cleanup indefinitely. On timeout we fall back
                    // to single-node behaviour (the catch below).
                    const probe = (async (): Promise<number> => {
                        const { connectValkey } = await import('$lib/server/cache/valkey');
                        await connectValkey();
                        const { getLiveInstanceIds } =
                            await import('$lib/server/services/cluster-heartbeat.service.js');
                        return (await getLiveInstanceIds()).size;
                    })();
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    const timeout = new Promise<never>((_, reject) => {
                        timer = setTimeout(() => reject(new Error('peer-probe timeout')), 5000);
                        timer.unref?.();
                    });
                    try {
                        // getLiveInstanceIds always includes self, so size > 1
                        // means peers exist. Protect sessions heartbeated within
                        // the window — must exceed the client heartbeat cadence
                        // (well under a minute) so live sessions are never
                        // mistaken for orphans; 90s gives comfortable margin.
                        const liveCount = await Promise.race([probe, timeout]);
                        if (liveCount > 1) {
                            graceSeconds = STARTUP_SESSION_CRASH_GRACE_SECONDS;
                        }
                    } finally {
                        if (timer) clearTimeout(timer);
                    }
                } catch {
                    // Peer probe failed or timed out — fall back to single-node behaviour.
                    graceSeconds = 0;
                }
                const { reapBootOrphanSessions } =
                    await import('$lib/server/services/play-sessions.service.js');
                const { crashed: count, completed } = await reapBootOrphanSessions(
                    sql,
                    graceSeconds,
                );
                if (count > 0) {
                    startupLogger.info(
                        `Marked ${count} orphaned play session(s) as CRASHED (server restart)`,
                        { graceSeconds },
                    );
                }
                if (completed > 0) {
                    startupLogger.info(
                        `Finalized ${completed} orphaned play session(s) as COMPLETED (crossed completion threshold before the restart)`,
                        { graceSeconds },
                    );
                }
            }
        })
        .catch((err) => {
            // Escalate to error — if this consistently fails, orphan
            // ACTIVE play sessions accumulate against quota indefinitely.
            // A liveness-check on the replica should flag this.
            startupLogger.error(
                'Play session startup cleanup failed — orphan ACTIVE sessions may accumulate',
                err instanceof Error ? err : new Error(String(err)),
                { tag: 'PLAY_SESSION_STARTUP_CLEANUP_FAILED' },
            );
        });

    // Register task/plugin contracts and queue producers for HTTP/admin APIs.
    void import('./task-runtime/web-lifecycle.js')
        .then(({ startWebTaskSubsystem }) => startWebTaskSubsystem())
        .catch((err: unknown) => {
            startupLogger.warn('Failed to initialize unified plugin system', {
                error: String(err),
            });
        });

    // Release any stale advisory locks from previous runs
    void releaseAllAdvisoryLocks();

    // Start cluster heartbeat service. The heartbeat (Valkey key) works without DB —
    // only the transition detector needs SQL. This allows proxy replicas (no DB) to
    // still appear as live nodes in the cluster overview.
    void (async () => {
        try {
            await ensureDatabaseMigration();
            const { clusterHeartbeatService } =
                await import('$lib/server/services/cluster-heartbeat.service.js');
            const { aiDbService } = await import('$lib/server/services/database.service.js');
            const sql = await aiDbService.getSql();
            await clusterHeartbeatService.start(sql);
            startupLogger.info('Cluster heartbeat service started', {
                hasDb: !!sql,
            });
        } catch (err) {
            startupLogger.warn('Failed to start cluster heartbeat service', {
                error: String(err),
            });
        }
    })();

    // Periodic memory breakdown (main heap, buffers, worker-thread heaps) so a
    // container's RSS can be attributed without a heap snapshot.
    void (async () => {
        try {
            const { deriveNodeRole } =
                await import('$lib/server/services/cluster-heartbeat.service.js');
            const { startMemoryBreakdownLog } =
                await import('$lib/server/services/memory-breakdown-log.js');
            startMemoryBreakdownLog({ role: deriveNodeRole() });
        } catch (err) {
            startupLogger.warn('Failed to start the memory breakdown log', {
                error: String(err),
            });
        }
    })();

    // Load the optional proprietary licensing module at boot. Its refresh loop
    // enrols a fresh install (first attempt ~5s after load) — without this the
    // module only loaded on the first request that resolved entitlements, so an
    // idle install could sit unlicensed indefinitely. A no-op in a tree without
    // the proprietary dirs (the AGPL shim's glob matches nothing).
    void (async () => {
        try {
            await ensureDatabaseMigration();
            const { ensureProprietaryLoaded } =
                await import('$lib/server/licensing/entitlements.js');
            await ensureProprietaryLoaded();
        } catch (err) {
            startupLogger.warn('Failed to load the licensing module at boot', {
                error: String(err),
            });
        }
    })();

    // Route WebSocket upgrades (e.g. /j/socket) to handlers registered via
    // registerUpgradeHandler(). Claims only registered paths; every other
    // upgrade request keeps Node's default handling.
    installUpgradeDispatch();

    // A saved metadata provider key re-scans libraries whose items were added
    // while no provider could answer, so they get identified in place.
    void import('$lib/server/services/provider-key-rematch.service.js')
        .then((m) => m.installProviderKeyRematchTrigger())
        .catch((err: unknown) => {
            startupLogger.warn('Failed to install the provider-key re-match trigger', {
                error: String(err),
            });
        });

    // Subscribe to cross-replica plugin-settings cache invalidation so an admin
    // PATCH on any replica fans the cache drop out to all others via Valkey pub/sub.
    void (async () => {
        try {
            const { startProviderSettingsCacheInvalidation } =
                await import('$lib/server/plugins/runtime/field-authority-loader.js');
            await startProviderSettingsCacheInvalidation();
        } catch (err) {
            startupLogger.warn('Failed to start plugin-settings invalidation subscriber', {
                error: String(err),
            });
        }
    })();

    // Start cache warming (non-blocking, runs in background)
    if (CACHE_WARMING_ENABLED) {
        startupLogger.info('Initiating cache warming...');
        // A function: re-read on each warm, so the CACHE_WARM_* settings (live
        // config bindings) apply without a restart.
        startCacheWarming(() => ({
            enabled: true,
            trendingEnabled: CACHE_WARM_TRENDING,
            metadataEnabled: CACHE_WARM_METADATA,
            heroNextUpEnabled: CACHE_WARM_HERO,
            browseEnabled: CACHE_WARM_BROWSE,
            activeUsersLimit: CACHE_WARM_USERS_LIMIT,
            metadataLimit: CACHE_WARM_METADATA_LIMIT,
            activeUsersDays: CACHE_WARM_ACTIVE_DAYS,
        })).catch((error) => {
            startupLogger.warn('Cache warming failed (non-critical)', {
                error: String(error),
            });
        });

        // Start nightly cache warming scheduler (runs at 3 AM by default)
        startNightlyScheduler(CACHE_WARM_NIGHTLY_HOUR);
    } else {
        startupLogger.info('Cache warming disabled');
    }

    // TODO(pre-release): Remove once all deployments have upgraded past this version.
    // See trickplay-storage.service.ts for details.
    // Migrate trickplay storage from legacy _sources/ layout (non-blocking, one-time)
    import('$lib/server/services/trickplay-storage.service.js')
        .then(async ({ migrateTrickplayStorage, cleanupOrphanedTrickplay }) => {
            await migrateTrickplayStorage();
            try {
                const cleaned = await cleanupOrphanedTrickplay();
                if (cleaned > 0) {
                    startupLogger.info('Cleaned up orphaned trickplay artifacts', {
                        count: cleaned,
                    });
                }
            } catch (cleanupErr) {
                startupLogger.warn('Trickplay orphan cleanup failed (non-critical)', {
                    error: String(cleanupErr),
                });
            }
        })
        .catch((error) => {
            startupLogger.warn('Trickplay storage migration failed (non-critical)', {
                error: String(error),
            });
        });

    // Run image cache cleanup on startup (non-blocking, runs in background)
    if (config.IMAGE_CACHE_CLEANUP_ON_STARTUP) {
        import('$lib/server/utils/image-cache-cleanup.js')
            .then(({ cleanupImageCaches }) => {
                cleanupImageCaches().catch((error) => {
                    startupLogger.warn('Image cache cleanup failed (non-critical)', {
                        error: String(error),
                    });
                });
            })
            .catch((error) => {
                startupLogger.warn('Failed to import image cache cleanup module', {
                    error: String(error),
                });
            });
    }

    // Rebuild the preview-cache disk-budget index from artifacts that survived
    // a restart (non-blocking, runs in background). PREVIEW_CACHE_DIR is a
    // per-replica local disk cache — same tier as the
    // trickplay/image caches above, so every replica that can serve preview
    // requests scans its own directory here. Without this call,
    // PreviewCacheStore's in-memory index starts empty on every restart: the
    // disk budget goes blind to whatever is already on disk (unbounded growth
    // under /config/cache/preview) and a warm cache never survives a restart.
    if (config.PREVIEW_CACHE_ENABLED) {
        Promise.all([
            import('$lib/server/services/preview-cache.store.js'),
            import('$lib/server/services/ffmpeg-transcode.service.js'),
        ])
            .then(([{ getPreviewCacheStore }, { getFFmpegTranscodeService }]) => {
                // Registered before scanOnStartup so any entry the scan later
                // evicts (over budget on boot) also closes out its stale
                // FFmpeg job, same as evictions during normal operation.
                getPreviewCacheStore().setOnDrop((key) => {
                    void getFFmpegTranscodeService()
                        .stopJob(`preview-cache-${key}`)
                        .catch(() => {});
                });
                return getPreviewCacheStore().scanOnStartup();
            })
            .then(() => {
                startupLogger.info('Preview cache scanOnStartup complete');
            })
            .catch((error) => {
                startupLogger.warn('Preview cache scanOnStartup failed (non-critical)', {
                    error: String(error),
                });
            });
    }

    // Initialize subtitle cache (creates directory, checks FFmpeg, cleans up temp files)
    import('$lib/server/services/subtitle-cache.service.js')
        .then(async () => {
            // No directory is created here: SubtitleFileCacheService creates its
            // own on first write. Pre-creating the LEGACY `cache/subtitles` dir
            // made its migration check pick that unmounted path on every fresh
            // container, so the cache was per-replica and died with each deploy.

            // Check FFmpeg availability
            try {
                const { spawn } = await import('child_process');
                await new Promise<void>((resolve, reject) => {
                    const ffmpeg = spawn(config.FFMPEG_PATH, ['-version']);
                    let stderr = '';

                    ffmpeg.stderr.on('data', (chunk: Buffer) => {
                        stderr += chunk.toString();
                    });

                    ffmpeg.on('close', (code) => {
                        if (code === 0) {
                            startupLogger.info('FFmpeg available for subtitle extraction');
                            resolve();
                        } else {
                            reject(new Error(`FFmpeg check failed: ${stderr}`));
                        }
                    });

                    ffmpeg.on('error', reject);

                    // Timeout after 5 seconds
                    setTimeout(() => {
                        ffmpeg.kill();
                        reject(new Error('FFmpeg check timeout'));
                    }, 5000);
                });
            } catch (error) {
                startupLogger.warn(
                    'FFmpeg not available - subtitle extraction will fall back to Jellyfin API',
                    {
                        error: String(error),
                    },
                );
            }

            // Note: File cleanup is handled automatically by the service constructor
            startupLogger.info('Subtitle cache service initialized');
        })
        .catch((error) => {
            startupLogger.warn('Failed to initialize subtitle cache service (non-critical)', {
                error: String(error),
            });
        });

    // End watch parties whose host is gone (no connection and no heartbeat for
    // WATCH_TOGETHER_HOST_ABSENT_MINUTES); one replica sweeps per minute.
    import('$lib/server/services/watch-together-host-sweeper.js')
        .then(({ startWatchTogetherHostSweeper }) => {
            startWatchTogetherHostSweeper();
        })
        .catch((error) => {
            startupLogger.warn('Failed to start watch-together host sweeper (non-critical)', {
                error: String(error),
            });
        });

    // Start transcoding cache tracker (tracks HLS segment directory size for multi-audio feature)
    import('$lib/server/services/transcoding-cache-tracker.js')
        .then(({ transcodingCacheTracker }) => {
            transcodingCacheTracker.start();
        })
        .catch((error) => {
            startupLogger.warn('Failed to start transcoding cache tracker (non-critical)', {
                error: String(error),
            });
        });

    // Drain Live TV stream failures out of Valkey into Postgres. The stream proxy is a
    // standalone bundle that cannot reach the database, so without this its forensics
    // stay in a capped cache list and die with it.
    import('$lib/server/services/livetv/livetv-failure-drain.js')
        .then(({ startLiveTvFailureDrain }) => {
            startLiveTvFailureDrain();
        })
        .catch((error) => {
            startupLogger.warn('Failed to start Live TV failure drain (non-critical)', {
                error: String(error),
            });
        });

    // Validate FFmpeg configuration
    if (!config.FFMPEG_PATH) {
        startupLogger.error(
            'MISCONFIGURATION: FFMPEG_PATH must be set — ' +
                'local file playback will be broken. Add FFMPEG_PATH=/path/to/ffmpeg to your environment.',
        );
    } else {
        startupLogger.info('HLS transcoding enabled', {
            ffmpegPath: config.FFMPEG_PATH,
            transcodeDir: config.FFMPEG_TRANSCODE_DIR,
        });
    }

    // Validate auth feature flag coherence
    if (config.FEATURE_DEVICE_AUTH && !features.deviceAuth) {
        startupLogger.error(
            'MISCONFIGURATION: FEATURE_DEVICE_AUTH=true requires JWT_SECRET to be set — ' +
                'device auth and Apple TV login will fail silently. Add JWT_SECRET to your environment.',
        );
    }
    if (config.FEATURE_USER_PATS && !features.userPats) {
        startupLogger.error(
            'MISCONFIGURATION: FEATURE_USER_PATS=true requires JWT_SECRET to be set — ' +
                'user PAT creation will be silently disabled.',
        );
    }
    if (config.JWT_SECRET && config.JWT_SECRET.length < 32) {
        startupLogger.warn(
            'JWT_SECRET is shorter than 32 chars (256 bits) — recommended minimum for HS256.',
            { length: config.JWT_SECRET.length },
        );
    }
}

// Graceful shutdown: drain HTTP first, then stop services, close pools last.
// Order and rationale: $lib/server/lifecycle/web-shutdown.ts.
// "Is a server the shutdown steps depend on gone?": answered by the network, around
// every pool and client of this process (see lifecycle/infrastructure-probe.ts).
const shutdownInfrastructureProbe = createInfrastructureProbe({
    targets: probeTargetsFromEnvironment(process.env, { cache: true }),
});
const gracefulShutdown = createWebShutdown({
    isDependencyGone: async () => (await shutdownInfrastructureProbe.verdict()).state === 'gone',
    // adapter-node (registered after this module loads) closes its HTTP server
    // on the same signal and emits this event once every connection closed.
    // vite dev has no adapter: only the in-flight request count is waited for.
    waitForHttpServerClosed: dev
        ? undefined
        : () => new Promise<void>((resolve) => process.once('sveltekit:shutdown', () => resolve())),
    drainTimeoutMs: drainTimeoutMsFromEnv(process.env),
    log: {
        info: (message, context) => serverLogger.info(message, context),
        warn: (message, context) => serverLogger.warn(message, context),
        error: (message, error) => serverLogger.error(message, error),
    },
    exit: (code) => process.exit(code),
    services: [
        {
            // First: the Valkey clients' native core logs at ERROR while they lose their server.
            name: 'native Valkey logs',
            run: async () => {
                const { silenceGlideLoggerForShutdown } =
                    await import('$lib/server/cache/valkey.js');
                silenceGlideLoggerForShutdown();
            },
        },
        {
            name: 'sessions cache',
            run: () => sessionsCacheService.stopCaching(),
        },
        {
            name: 'web task subsystem',
            timeoutMs: 6_000,
            run: async () => {
                const { stopWebTaskSubsystem } = await import('./task-runtime/web-lifecycle.js');
                await stopWebTaskSubsystem();
            },
        },
        {
            name: 'cluster heartbeat',
            run: async () => {
                const { clusterHeartbeatService } =
                    await import('$lib/server/services/cluster-heartbeat.service.js');
                await clusterHeartbeatService.stop();
            },
        },
        {
            name: 'memory breakdown log',
            run: async () => {
                const { stopMemoryBreakdownLog } =
                    await import('$lib/server/services/memory-breakdown-log.js');
                stopMemoryBreakdownLog();
            },
        },
        { name: 'nightly scheduler', run: () => stopNightlyScheduler() },
        {
            name: 'cache cleanup interval',
            run: async () => {
                const { cacheManager } = await import('$lib/server/cache');
                cacheManager.stopCleanupInterval();
            },
        },
        {
            name: 'transcoding cache tracker',
            run: async () => {
                const { transcodingCacheTracker } =
                    await import('$lib/server/services/transcoding-cache-tracker.js');
                transcodingCacheTracker.stop();
            },
        },
        {
            // Stops active FFmpeg jobs; must happen before advisory lock release.
            name: 'FFmpeg transcode service',
            timeoutMs: 8_000,
            run: async () => {
                const { shutdownFFmpegTranscodeService } =
                    await import('$lib/server/services/ffmpeg-transcode.service.js');
                await shutdownFFmpegTranscodeService();
            },
        },
        {
            // Stops the flush interval and drains pendingEvents before the pool closes.
            name: 'playback telemetry',
            // Its own shutdown waits up to 5 s for in-flight writes, then flushes.
            timeoutMs: 8_000,
            run: async () => {
                const { playbackTelemetryService } =
                    await import('$lib/server/services/playback-telemetry.service.js');
                await playbackTelemetryService.shutdown();
            },
        },
        {
            name: 'PAT usage',
            run: async () => {
                const { flushPatUsage } = await import('$lib/server/oauth/pat.service.js');
                await flushPatUsage();
            },
        },
        // After all persistence work.
        { name: 'advisory locks', run: () => releaseAllAdvisoryLocks() },
        {
            name: 'subtitle cache service',
            run: async () => {
                const { subtitleCacheService } =
                    await import('$lib/server/services/subtitle-cache.service.js');
                subtitleCacheService.shutdown();
            },
        },
    ],
    pools: [
        {
            name: 'Valkey subscriptions',
            run: async () => {
                const { closeAllSubscriptions } = await import('$lib/server/cache/valkey.js');
                await closeAllSubscriptions();
            },
        },
        {
            name: 'Valkey clients',
            run: async () => {
                const { disconnectValkey } = await import('$lib/server/cache/valkey.js');
                await disconnectValkey();
            },
        },
        {
            name: 'database pools',
            // closeDb force-closes a pool after 3 s: never cut it off before that.
            timeoutMs: 5_000,
            keepBudgetWhenGone: true,
            run: async () => {
                const { closeDb } = await import('$lib/server/database/connection.js');
                await closeDb();
            },
        },
        {
            name: 'undici agent',
            run: async () => {
                const { cleanupUndiciAgent } = await import('$lib/server/runtime-optimizations.js');
                await cleanupUndiciAgent();
            },
        },
    ],
});

// Register shutdown handlers. Remove only this module's previous pair (HMR
// re-evaluates it): adapter-node's own listeners (they close the HTTP server
// and emit `sveltekit:shutdown`) and socket-hub's must survive whatever the
// load order.
const SHUTDOWN_LISTENERS = Symbol.for('lumastra.webShutdownListeners');
type ShutdownListenerSlot = { term: () => void; int: () => void };
const listenerSlot = globalThis as typeof globalThis & {
    [SHUTDOWN_LISTENERS]?: ShutdownListenerSlot;
};
const previousListeners = listenerSlot[SHUTDOWN_LISTENERS];
if (previousListeners) {
    process.off('SIGTERM', previousListeners.term);
    process.off('SIGINT', previousListeners.int);
}
const shutdownListeners: ShutdownListenerSlot = {
    term: () => void gracefulShutdown('SIGTERM'),
    int: () => void gracefulShutdown('SIGINT'),
};
listenerSlot[SHUTDOWN_LISTENERS] = shutdownListeners;
process.on('SIGTERM', shutdownListeners.term);
process.on('SIGINT', shutdownListeners.int);

// adapter-node registers its SIGTERM listener right after this module loads.
// Without it nothing closes the HTTP server, and every shutdown waits the
// whole drain timeout: say so instead of silently rolling slowly.
if (!dev && !building) {
    setTimeout(() => {
        if (process.listenerCount('SIGTERM') < 2) {
            serverLogger.error(
                'adapter-node SIGTERM listener missing: shutdown cannot close the HTTP server and will wait the full drain timeout',
            );
        }
    }, 10_000).unref();
}

// Plugin-isolation safety net. This process hosts third-party task plugins;
// a plugin that spawns un-awaited async work (a `void`/`.then()` without
// `.catch()`, a timer/event callback inside execute()) produces an
// `unhandledRejection`. On Node ≥22 the default action is to treat it as a
// throw and EXIT — which takes down the process and strands its active
// in-flight runs in 'active' until boot recovery. Log-and-continue instead so
// one buggy plugin can't crash the whole app. (Boot recovery reclaims any run
// the offending plugin was mid-flight on; operators should still alert on
// these logs.) Registered idempotently like the signal handlers above.

// Pure handler bodies — extracted so the suppression behavior (log-and-
// continue, never rethrow/exit) can be unit tested without registering real
// process-level listeners.
export function handleUnhandledRejection(reason: unknown, logger: LoggerInstance): void {
    logger.error(
        'Unhandled promise rejection (suppressed to protect the worker/web process)',
        reason instanceof Error ? reason : new Error(String(reason)),
    );
}

export function handleUncaughtException(err: Error, logger: LoggerInstance): void {
    logger.error('Uncaught exception (suppressed to protect the worker/web process)', err);
}

process.removeAllListeners('unhandledRejection');
process.removeAllListeners('uncaughtException');
process.on('unhandledRejection', (reason: unknown) => {
    handleUnhandledRejection(reason, serverLogger);
});
process.on('uncaughtException', (err: Error) => {
    handleUncaughtException(err, serverLogger);
});
