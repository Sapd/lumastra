// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Config doctor — preflight validation of environment configuration that would
// otherwise fail silently or at first use. Designed to run from THREE places:
//   - a standalone CLI (`npm run doctor`) — see scripts/doctor.ts
//   - container boot (STEP 0) — fail fast before a broken config serves traffic
//   - a runtime health endpoint (/api/health/config) — surface drift to admins
//
// It reads `process.env` by default so it has no dependency on the config
// singletons (which may not be wired yet at boot) and can run in any context.
// Pass an explicit input to validate a non-env source.

import type postgres from 'postgres';
import {
    checkEmbeddingColumnDimension,
    resolveEffectiveEmbedding,
    validateEmbeddingConfig,
    type EmbeddingResolverInput,
    type ResolvedEmbedding,
} from '../ai/embedding-models.js';
import { forwardAuthTrustPosture } from '../utils/client-ip.js';
import {
    DISABLED_HEADER_RECENT_MS,
    getIgnoredForwardAuthSighting,
} from '../utils/forward-auth-disabled-observer.js';
import {
    describeGatewayTrust,
    detectGatewayTrust,
    readProcNetRoute,
} from '../utils/docker-gateway-trust.js';
import { describeWideTrustedProxyRanges, runsOnKubernetes } from '../utils/trusted-proxy-ranges.js';
import { config } from '../config.js';
import { resolveMasterKey } from '../crypto/master-key.js';
import {
    testCacheConnection,
    testDatabaseConnection,
    type ConnectivityResult,
} from './connectivity.js';

export type DoctorSeverity = 'error' | 'warning' | 'info';

export interface DoctorIssue {
    readonly category: string;
    readonly severity: DoctorSeverity;
    readonly code: string;
    readonly message: string;
    readonly remediation?: string;
}

export interface DoctorReport {
    /** True when there are no `error`-severity issues. */
    readonly ok: boolean;
    readonly errorCount: number;
    readonly warningCount: number;
    readonly issues: DoctorIssue[];
    /** Resolved values shown for context even when everything is fine. */
    readonly resolved: {
        readonly embedding: ResolvedEmbedding;
    };
}

function parseDimensions(raw: string | undefined): number {
    const n = Number.parseInt((raw ?? '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Build the embedding resolver input from a `process.env`-shaped record. */
export function embeddingInputFromEnv(
    env: Record<string, string | undefined> = process.env,
): EmbeddingResolverInput {
    return {
        embeddingModel: env.EMBEDDING_MODEL,
        embeddingDimensions: parseDimensions(env.EMBEDDING_DIMENSIONS),
        embeddingBaseUrl: env.EMBEDDING_BASE_URL,
        embeddingApiKey: env.EMBEDDING_API_KEY,
        voyageApiKey: env.VOYAGE_API_KEY,
        openaiApiKey: env.OPENAI_API_KEY,
    };
}

export interface DoctorOptions {
    /** Embedding config to validate. Defaults to `embeddingInputFromEnv()`. */
    readonly embedding?: EmbeddingResolverInput;
    /** Env source for the secrets/proxy/connectivity checks. Defaults to `process.env`. */
    readonly env?: Record<string, string | undefined>;
    /**
     * `/proc/net/route` content for the gateway-trust check. Defaults to reading
     * the file (null off Linux → check skipped); pass null to skip explicitly.
     */
    readonly procNetRoute?: string | null;
}

/** Helper: is a string env var present and non-blank? */
function isPresent(raw: string | undefined): boolean {
    return typeof raw === 'string' && raw.trim().length > 0;
}

/**
 * Secrets that must be present for core features. JWT_SECRET signs/validates
 * tokens (always an error if missing). LUMASTRA_MASTER_KEY decrypts plugin
 * secrets — fatal in production (plugins can't read credentials), a warning
 * elsewhere (dev may have no encrypted plugin secrets yet).
 */
function checkSecrets(env: Record<string, string | undefined>): Omit<DoctorIssue, 'category'>[] {
    const issues: Omit<DoctorIssue, 'category'>[] = [];
    const isProduction = env.NODE_ENV === 'production';

    // Use the EFFECTIVE secret (config.JWT_SECRET), which falls back to a value
    // derived deterministically from LUMASTRA_MASTER_KEY when JWT_SECRET is unset.
    // So a configured master key already satisfies token signing — only flag when
    // neither is available.
    if (!isPresent(config.JWT_SECRET)) {
        issues.push({
            severity: 'error',
            code: 'secrets.jwt-secret-missing',
            message:
                'No token-signing secret is available: JWT_SECRET is unset and there is no LUMASTRA_MASTER_KEY to derive one from, so API/service tokens, device auth and HLS stream tokens cannot be signed.',
            remediation:
                'Set LUMASTRA_MASTER_KEY (recommended — it also encrypts stored secrets, and JWT_SECRET is then derived automatically), or set an explicit JWT_SECRET (e.g. `openssl rand -hex 32`). Keep it stable across replicas and restarts.',
        });
    }

    // Effective master key: explicit env, or the file-backed key auto-generated
    // on first use (resolveMasterKey persists one into the config dir). Calling it
    // here — the doctor runs at boot — is what triggers generation, so a fresh
    // install gets an encrypted-at-rest key without operator action. Only flag
    // when a key can be neither resolved nor written (e.g. an unwritable config
    // dir), in which case secrets fall back to plaintext.
    if (!isPresent(resolveMasterKey())) {
        issues.push({
            severity: isProduction ? 'error' : 'warning',
            code: 'secrets.master-key-missing',
            message:
                'No master key is available and one could not be generated — the config directory may be unwritable. Stored secrets will be kept in PLAINTEXT and JWT-derived tokens cannot be signed.',
            remediation:
                'Set LUMASTRA_MASTER_KEY to a long, random secret (e.g. `openssl rand -hex 32`), or make the config directory writable so a key file can be created. Keep the key stable across restarts/replicas.',
        });
    }

    return issues;
}

/**
 * Transport / secure-cookie posture for native login. The session cookie keeps
 * `Secure` unless the request shows plain HTTP (auth/cookie-transport.ts): the
 * forwarded protocol from a trusted proxy, or the browser's Origin on a POST,
 * says http. ORIGIN set to https makes it `Secure` on every request. Without
 * ORIGIN nothing is lost on an HTTPS deployment (no evidence keeps `Secure`),
 * so this is an info note only: `npm run doctor` prints it, the admin banner
 * drops `info` issues (config-health-view.ts). Only meaningful when native
 * login is enabled in production.
 */
function checkTransport(env: Record<string, string | undefined>): Omit<DoctorIssue, 'category'>[] {
    if (env.NODE_ENV !== 'production') return [];
    if (!config.AUTH_NATIVE_LOGIN_ENABLED) return [];

    const hasOrigin = !!env.ORIGIN?.trim();
    const hasProtocolHeader = !!env.PROTOCOL_HEADER?.trim();
    if (hasOrigin || hasProtocolHeader) return [];

    return [
        {
            severity: 'info',
            code: 'transport.session-cookie-secure-info',
            message:
                'ORIGIN is not set. The login session cookie is marked Secure unless the request came in over plain HTTP, which Lumastra reads from the X-Forwarded-Proto header of a trusted proxy or from the browser itself. Plain HTTP on the LAN can sign in. Set ORIGIN to your public https URL to mark the cookie Secure on every request.',
        },
    ];
}

/**
 * Forward-auth posture: the FORWARD_AUTH_ENABLED opt-in against the peer trust
 * (TRUSTED_PROXY_IPS / LUMASTRA_TRUST_ANY_PROXY). Only meaningful in production
 * — dev bypasses forward auth, so this check is skipped there.
 *
 * - No sign-in method at all (forward auth off or untrusted-from-everyone, and
 *   neither built-in login nor OIDC) is a hard error.
 * - Forward auth on but no peer trusted: warning, it cannot sign anyone in.
 * - Forward auth on with trust-any: warning (safe only when not directly reachable).
 * - Forward auth off while identity headers ARRIVE from a trusted proxy (seen by
 *   this server process; `npm run doctor` runs in its own process and never
 *   sees one): warning — a forward-auth install that missed the upgrade step,
 *   or a proxy that passes client-sent identity headers through.
 * - Forward auth off with TRUSTED_PROXY_IPS / trust-any set: info, so an
 *   operator who did mean forward auth finds the switch.
 */
function checkForwardAuth(
    env: Record<string, string | undefined>,
): Omit<DoctorIssue, 'category'>[] {
    if (env.NODE_ENV !== 'production') return [];

    const posture = forwardAuthTrustPosture();
    const enabled = config.FORWARD_AUTH_ENABLED === true;
    // Native (built-in) login AND OIDC single sign-on each authenticate users
    // independently of forward auth. (AUTH_OIDC_LOGIN_AVAILABLE is the shared
    // enabled+issuer+client-id predicate, derived on `config` so this preflight
    // doesn't pull openid-client in via oidc.service.)
    const otherSignIn = config.AUTH_NATIVE_LOGIN_ENABLED || config.AUTH_OIDC_LOGIN_AVAILABLE;

    if (!otherSignIn && (!enabled || posture === 'fail-closed')) {
        return [
            {
                severity: 'error',
                code: 'forward-auth.fail-closed',
                message: enabled
                    ? 'No authentication is configured: FORWARD_AUTH_ENABLED is on but no proxy is trusted (TRUSTED_PROXY_IPS unset, LUMASTRA_TRUST_ANY_PROXY off), built-in login is disabled, and OIDC SSO is not configured — so no one can sign in.'
                    : 'No authentication is configured: forward auth is off (FORWARD_AUTH_ENABLED), built-in login is disabled, and OIDC SSO is not configured — so no one can sign in.',
                remediation:
                    'Enable built-in login (AUTH_NATIVE_LOGIN_ENABLED=true) and create an admin via /setup, OR configure OIDC SSO (AUTH_OIDC_ENABLED=true + AUTH_OIDC_ISSUER + AUTH_OIDC_CLIENT_ID), OR set FORWARD_AUTH_ENABLED=true and TRUSTED_PROXY_IPS for forward-auth SSO.',
            },
        ];
    }

    if (enabled) {
        if (posture === 'fail-closed') {
            return [
                {
                    severity: 'warning',
                    code: 'forward-auth.enabled-without-trusted-proxy',
                    message:
                        'FORWARD_AUTH_ENABLED is on but TRUSTED_PROXY_IPS is empty, so identity headers are rejected from every peer and nobody can sign in through the forward-auth proxy.',
                    remediation:
                        'Set TRUSTED_PROXY_IPS to the address your reverse proxy connects from, or turn FORWARD_AUTH_ENABLED off if you sign in with built-in login or OIDC only.',
                },
            ];
        }
        if (posture === 'trust-any') {
            return [
                {
                    severity: 'warning',
                    code: 'forward-auth.trust-any',
                    message:
                        'LUMASTRA_TRUST_ANY_PROXY=true trusts identity headers from any peer; safe only if the app isn’t directly reachable.',
                    remediation:
                        'Prefer pinning TRUSTED_PROXY_IPS to your reverse-proxy IP(s) in production.',
                },
            ];
        }
        return [];
    }

    const sighting = getIgnoredForwardAuthSighting();
    if (sighting && Date.now() - sighting.lastSeenAt < DISABLED_HEADER_RECENT_MS) {
        return [
            {
                severity: 'warning',
                code: 'forward-auth.headers-while-disabled',
                message: `Forward-auth identity headers (${sighting.lastHeaders.join(', ')}) arrived from a trusted proxy (${sighting.lastPeer}) on ${sighting.count} request(s) since start, but FORWARD_AUTH_ENABLED is off, so they were ignored.`,
                remediation:
                    'If you sign in through a forward-auth proxy (Authentik, Authelia, oauth2-proxy), set FORWARD_AUTH_ENABLED=true. Otherwise make your reverse proxy strip these headers from client requests.',
            },
        ];
    }
    if (posture !== 'fail-closed') {
        return [
            {
                severity: 'info',
                code: 'forward-auth.disabled-with-trusted-proxy',
                message:
                    posture === 'allowlist'
                        ? 'TRUSTED_PROXY_IPS is set but forward auth is off, so these proxies only supply client IPs and their identity headers are ignored.'
                        : 'LUMASTRA_TRUST_ANY_PROXY=true has no effect while forward auth is off.',
                remediation:
                    'If you sign in through a forward-auth proxy, set FORWARD_AUTH_ENABLED=true. Nothing to do otherwise.',
            },
        ];
    }
    return [];
}

/**
 * TRUSTED_PROXY_IPS trusting the container's default gateway (the Docker host):
 * every local process can then forge forward-auth headers. A warning, never an
 * error — it must not block startup. Posture-independent and not limited to
 * production: the allowlist is honored in every mode.
 */
function checkGatewayTrust(
    env: Record<string, string | undefined>,
    procNetRoute: string | null,
): Omit<DoctorIssue, 'category'>[] {
    const finding = detectGatewayTrust({ trustedProxyIps: env.TRUSTED_PROXY_IPS, procNetRoute });
    if (!finding) return [];
    const { message, remediation } = describeGatewayTrust(finding);
    return [
        { severity: 'warning', code: 'forward-auth.trusts-docker-gateway', message, remediation },
    ];
}

/**
 * TRUSTED_PROXY_IPS listing a range wider than /24 (a LAN, not a proxy) or an
 * IPv6 range (matches nothing). See trusted-proxy-ranges.ts for the threshold.
 * A warning, never an error; info on Kubernetes, where the documented value is
 * the router's pod CIDR behind a NetworkPolicy.
 */
function checkWideTrustedProxyRanges(
    env: Record<string, string | undefined>,
): Omit<DoctorIssue, 'category'>[] {
    const report = describeWideTrustedProxyRanges({
        trustedProxyIps: env.TRUSTED_PROXY_IPS,
        forwardAuthEnabled: config.FORWARD_AUTH_ENABLED === true,
        kubernetes: runsOnKubernetes(env),
    });
    if (!report) return [];
    return [
        {
            severity: report.severity === 'warn' ? 'warning' : 'info',
            code: 'forward-auth.trusts-wide-range',
            message: report.message,
            remediation: report.remediation,
        },
    ];
}

/**
 * Run all preflight checks and return a structured report. Never throws —
 * callers decide what to do with errors (CLI exits non-zero, boot rethrows,
 * the health endpoint serializes the report).
 */
export function runConfigDoctor(options: DoctorOptions = {}): DoctorReport {
    const env = options.env ?? process.env;
    const embeddingInput = options.embedding ?? embeddingInputFromEnv(env);
    const issues: DoctorIssue[] = [];

    for (const issue of validateEmbeddingConfig(embeddingInput)) {
        issues.push({ category: 'embedding', ...issue });
    }

    for (const issue of checkSecrets(env)) {
        issues.push({ category: 'secrets', ...issue });
    }

    for (const issue of checkForwardAuth(env)) {
        issues.push({ category: 'forward-auth', ...issue });
    }

    const procNetRoute =
        options.procNetRoute !== undefined ? options.procNetRoute : readProcNetRoute();
    for (const issue of checkGatewayTrust(env, procNetRoute)) {
        issues.push({ category: 'forward-auth', ...issue });
    }

    for (const issue of checkWideTrustedProxyRanges(env)) {
        issues.push({ category: 'forward-auth', ...issue });
    }

    for (const issue of checkTransport(env)) {
        issues.push({ category: 'transport', ...issue });
    }

    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const warningCount = issues.filter((i) => i.severity === 'warning').length;

    return {
        ok: errorCount === 0,
        errorCount,
        warningCount,
        issues,
        resolved: {
            embedding: resolveEffectiveEmbedding(embeddingInput),
        },
    };
}

/**
 * Read the actual `vector(N)` width of `media_embeddings.embedding` from the
 * database, or `null` when the table/column does not exist yet (fresh install
 * before the schema migration runs). For a pgvector `vector(N)` column the
 * stored dimension is exactly `atttypmod` (NOT `atttypmod - 4` as for varlena
 * types) — verified against the base-schema squash bootstrap.
 */
export async function readEmbeddingColumnDimension(sql: postgres.Sql): Promise<number | null> {
    const rows = await sql<{ dim: number | null }[]>`
        SELECT a.atttypmod AS dim
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'media_embeddings'
          AND a.attname = 'embedding'
          AND a.attnum > 0
          AND NOT a.attisdropped
    `;
    const dim = rows[0]?.dim;
    return typeof dim === 'number' && dim > 0 ? dim : null;
}

/**
 * Run the config doctor AND a DB-aware check that the existing embedding vector
 * column width matches the configured embedding dimension. Catches the
 * provider-switch gap (Voyage 1024 ↔ OpenAI 1536) that the env-only
 * {@link runConfigDoctor} cannot see. Falls back to the pure report if the DB
 * query fails (e.g. permissions) — a doctor must never crash boot itself.
 */
export async function runConfigDoctorWithDb(
    sql: postgres.Sql,
    options: DoctorOptions = {},
): Promise<DoctorReport> {
    const base = runConfigDoctor(options);
    const env = options.env ?? process.env;
    const extra: DoctorIssue[] = [];

    // Connectivity probes — DB + cache reachability. Each probe is
    // self-contained and never throws (returns { ok:false }), so a dead
    // dependency becomes a finding, not an unhandled boot crash. allSettled is
    // belt-and-suspenders in case a future probe regresses to throwing.
    // The task Valkey (TASK_CACHE_URL) is required; the cache (CACHE_URL) is
    // optional — unset is fine, unreachable is only a warning (cache misses).
    const [dbProbe, taskProbe, cacheProbe] = await Promise.allSettled([
        testDatabaseConnection(env.DATABASE_URL),
        testCacheConnection(env.TASK_CACHE_URL, 'Task Valkey', 'TASK_CACHE_URL'),
        env.CACHE_URL
            ? testCacheConnection(env.CACHE_URL)
            : Promise.resolve<ConnectivityResult>({
                  service: 'Cache',
                  ok: true,
                  message: 'Not configured',
              }),
    ]);

    if (dbProbe.status === 'fulfilled' && !dbProbe.value.ok) {
        extra.push({
            category: 'database',
            severity: 'error',
            code: 'database.unreachable',
            message: `Database check failed: ${dbProbe.value.message}${
                dbProbe.value.details ? ` (${dbProbe.value.details})` : ''
            }`,
            remediation:
                'Set DATABASE_URL to a reachable PostgreSQL instance and verify credentials, host, port, and that the server is running.',
        });
    } else if (dbProbe.status === 'rejected') {
        extra.push({
            category: 'database',
            severity: 'error',
            code: 'database.probe-error',
            message: `Database connectivity probe threw: ${String(dbProbe.reason)}`,
            remediation: 'Check DATABASE_URL and that the PostgreSQL host is reachable.',
        });
    }

    if (taskProbe.status === 'fulfilled' && !taskProbe.value.ok) {
        extra.push({
            category: 'cache',
            severity: 'error',
            code: 'valkey.task-unreachable',
            message: `Task Valkey check failed: ${taskProbe.value.message}${
                taskProbe.value.details ? ` (${taskProbe.value.details})` : ''
            }`,
            remediation:
                'Set TASK_CACHE_URL to the reachable task Valkey (noeviction, AOF) and verify host, port, password and database.',
        });
    } else if (taskProbe.status === 'rejected') {
        extra.push({
            category: 'cache',
            severity: 'error',
            code: 'valkey.task-probe-error',
            message: `Task Valkey connectivity probe threw: ${String(taskProbe.reason)}`,
            remediation: 'Check TASK_CACHE_URL and that the Valkey host is reachable.',
        });
    }

    if (cacheProbe.status === 'fulfilled' && !cacheProbe.value.ok) {
        extra.push({
            category: 'cache',
            severity: 'warning',
            code: 'cache.unreachable',
            message: `Cache check failed: ${cacheProbe.value.message}${
                cacheProbe.value.details ? ` (${cacheProbe.value.details})` : ''
            }`,
            remediation:
                'The app keeps running without the cache (slower). Point CACHE_URL at a reachable Valkey, or unset it to cache in memory only.',
        });
    } else if (cacheProbe.status === 'rejected') {
        extra.push({
            category: 'cache',
            severity: 'warning',
            code: 'cache.probe-error',
            message: `Cache connectivity probe threw: ${String(cacheProbe.reason)}`,
            remediation: 'Check CACHE_URL and that the Valkey/Redis host is reachable.',
        });
    }

    try {
        const columnDimension = await readEmbeddingColumnDimension(sql);
        // Only meaningful when a provider is configured; otherwise the embedder
        // is disabled and column drift is moot.
        if (base.resolved.embedding.hasProvider) {
            for (const issue of checkEmbeddingColumnDimension(
                base.resolved.embedding.dimensions,
                columnDimension,
            )) {
                extra.push({ category: 'embedding', ...issue });
            }
        }
    } catch {
        // DB unreachable or table absent — the env-only checks still stand.
    }

    if (extra.length === 0) return base;

    const issues = [...base.issues, ...extra];
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const warningCount = issues.filter((i) => i.severity === 'warning').length;
    return {
        ...base,
        ok: errorCount === 0,
        errorCount,
        warningCount,
        issues,
    };
}

/** Render a report as human-readable lines (for the CLI and boot logs). */
export function formatDoctorReport(report: DoctorReport): string {
    const lines: string[] = [];
    const e = report.resolved.embedding;
    lines.push('Embedding configuration:');
    lines.push(`  provider:   ${e.provider}`);
    lines.push(`  model:      ${e.model} (${e.modelSource})`);
    lines.push(`  dimensions: ${e.dimensions} (${e.dimensionSource})`);
    lines.push('');

    if (report.issues.length === 0) {
        lines.push('✅ No configuration issues found.');
        return lines.join('\n');
    }

    for (const issue of report.issues) {
        const icon =
            issue.severity === 'error' ? '❌' : issue.severity === 'warning' ? '⚠️ ' : 'ℹ️ ';
        lines.push(`${icon} [${issue.category}/${issue.code}] ${issue.message}`);
        if (issue.remediation) lines.push(`   → ${issue.remediation}`);
    }
    lines.push('');
    lines.push(`${report.errorCount} error(s), ${report.warningCount} warning(s).`);
    return lines.join('\n');
}
