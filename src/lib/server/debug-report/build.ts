// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Assembles the admin debug report (spec 2026-10-21-admin-debug-report-design §4–5).
 *
 * One producer: every section is collected behind its own guard, shaped through
 * the ONE redaction context of the report (`redact.ts`), and the whole object
 * then passes the final secret assertion. The Markdown is rendered from this
 * redacted object only (`shared/debug-report-format.ts`), never from raw data.
 *
 * Every string that leaves this module goes through `sanitizeDebugText()` (or is
 * a fixed enum / count / number / a validated id), so a section that forgets the
 * redactor is caught by {@link assertNoSecrets} and counted in `redaction`.
 */

import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { getAll, getConfigState } from '$lib/server/config/config.service.js';
import { MIGRATIONS } from '$lib/server/database/migrate-schema.js';
import { BASE_SCHEMA_VERSION } from '$lib/server/database/base-schema.js';
import { MigrationSystem } from '$lib/server/database/migration-system.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { listFindings } from '$lib/server/database/queries/health-check-findings.queries.js';
import {
    countRestartsSince,
    getNodeTimeline,
} from '$lib/server/database/queries/cluster-nodes.queries.js';
import { listRunFailureRows } from '$lib/server/database/queries/failure-patterns.queries.js';
import { getLatestSnapshot } from '$lib/server/database/queries/task-metrics-snapshot.queries.js';
import {
    getLatestScannerRunPerLibrary,
    getStaleInFlightScannerRuns,
} from '$lib/server/database/queries/file-scanner-runs.queries.js';
import { countUnresolvedFailuresByPlugin } from '$lib/server/database/queries/plugin-failure-events.queries.js';
import { countOpenViolationsByRule } from '$lib/server/database/queries/integrity-violations.queries.js';
import {
    listClientDiagnosticGroup,
    summarizeClientDiagnostics,
} from '$lib/server/database/queries/client-diagnostics.queries.js';
import {
    countMediaHealthIssuesByType,
    getDatabaseVersions,
    listSampleFailedRuns,
} from '$lib/server/database/queries/debug-report.queries.js';
import { getReadinessChecks } from '$lib/server/health/readiness-checks.js';
import { buildComponentHealth } from '$lib/server/health/component-health.js';
import {
    readClusterNodes,
    type LiveClusterNode,
} from '$lib/server/services/cluster-heartbeat.service.js';
import { probeClusterSidecars } from '$lib/server/services/cluster-sidecar-probe.js';
import { connectionStatus } from '$lib/server/services/connection-status.service.js';
import { connectionStatuses } from '$lib/server/admin/connection-status.js';
import { hasHealthCheck, runProviderHealthCheck } from '$lib/server/admin/provider-health.js';
import { cacheGet, cacheSet, hasSeparateCoordinationValkey } from '$lib/server/cache/valkey.js';
import { getRuntimeEnvironment } from '$lib/server/utils/runtime-environment.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { logBuffer } from '$lib/server/tasks/log-buffer.js';
import { toPublicRun } from '$lib/server/tasks/run-event.js';
import { DEBUG_REPORT_PATH } from '$lib/server/auth/diagnostics-grant.js';
import { appPath } from '$lib/shared/api-urls.js';
import type {
    ClientDiagnosticGroupDetail,
    ClusterNodeDetail,
    DebugReport,
    RunDetail,
} from '$lib/schemas/debug-report.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    assertNoSecrets,
    collectSecretValues,
    collectUserinfoPairs,
    createRedactionContext,
    redactConfigForReport,
    sanitizeDebugText,
    type RedactionContext,
    type RedactionOptions,
} from './redact.js';
import { DebugReportConfigurationError } from './errors.js';

const logger = Logger.for('DebugReport');

/** Window of every "last 24 hours" figure in the report. */
const WINDOW_HOURS = 24;
/** Failed runs sampled per task, for the drill-down links. */
const SAMPLE_RUNS_PER_TASK = 3;
/** Log lines of one run in its drill-down. */
const RUN_LOG_LINES = 100;
/** Events of one client-diagnostic group in its drill-down. */
const CLIENT_GROUP_EVENTS = 20;
/** Events of one cluster node in its drill-down. */
const NODE_EVENTS = 50;
/** A provider reachability probe is cached this long (spec §4.8). */
const PROBE_CACHE_TTL_SECONDS = 300;
const PROBE_CACHE_PREFIX = 'v1:debug-report:probe:';
const PROBE_TIMEOUT_MS = 5_000;

/** Drill-downs never include hosts or paths. */
const NO_INCLUDE: RedactionOptions = { includeHostnames: false, includePaths: false };

/**
 * Task run ids: `run_` + a ULID (orchestrator), UUIDs on older rows. An id is an
 * internal handle, not data, so it passes through verbatim when it has this
 * shape — the free-text pass would take a ULID for an opaque secret — and is
 * dropped otherwise.
 */
const RUN_ID_RE =
    /^(?:run_[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const FINGERPRINT_RE = /^[0-9a-f]{32}$/;
const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type ReportSections = Omit<DebugReport, 'schemaVersion' | 'generatedAt' | 'redaction'>;
type ReportInstance = DebugReport['instance'];
type ReportHealth = DebugReport['health'];
type ReportCluster = DebugReport['cluster'];
type ReportTasks = DebugReport['tasks'];
type ReportLibrary = DebugReport['library'];
type ReportClientDiagnostics = DebugReport['clientDiagnostics'];
type ReportSettings = DebugReport['settings'];
type ReportIntegrations = DebugReport['integrations'];
type ReportLinks = DebugReport['links'];
type ReportClusterNode = ReportCluster['nodes'] extends (infer N)[] | undefined ? N : never;

/** Runs one collector. A failure becomes the section's own `unavailable` value. */
async function collect<T>(
    name: string,
    run: () => Promise<T>,
    unavailable: (note: string) => T,
): Promise<T> {
    try {
        return await run();
    } catch (error) {
        logger.warn(
            `Debug report section "${name}" unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return unavailable(`${name} could not be read. See the server log.`);
    }
}

/** Like {@link collect} for a value with a fallback and no section status. */
async function optional<T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await run();
    } catch (error) {
        logger.warn(
            `Debug report input "${name}" unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return fallback;
    }
}

/** Times out a probe so a hung provider costs at most {@link PROBE_TIMEOUT_MS}. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Free text: the one redaction pass. */
function clean(ctx: RedactionContext, text: string): string {
    return sanitizeDebugText(text, ctx);
}

/** Free text written by a user or client: untrusted, capped at 200. */
function untrusted(ctx: RedactionContext, text: string): { text: string; untrusted: true } {
    return { text: sanitizeDebugText(text, ctx, { untrusted: true }), untrusted: true };
}

/** `Date` or ISO string to ISO string, or undefined. */
function isoOf(value: unknown): string | undefined {
    if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
    if (typeof value === 'string' && value !== '') {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
    }
    return undefined;
}

/** Epoch milliseconds to ISO, or undefined when out of range. */
function isoOfMillis(ms: number): string | undefined {
    if (!Number.isFinite(ms)) return undefined;
    try {
        return new Date(ms).toISOString();
    } catch {
        return undefined;
    }
}

function reportLinks(): ReportLinks {
    const base = appPath(DEBUG_REPORT_PATH);
    return {
        self: base,
        markdown: `${base}?format=md`,
        health: appPath(`${DEBUG_REPORT_PATH}/health`),
        run: appPath(`${DEBUG_REPORT_PATH}/runs/{runId}`),
        clientDiagnosticGroup: appPath(`${DEBUG_REPORT_PATH}/client-diagnostics/{fingerprint}`),
        clusterNode: appPath(`${DEBUG_REPORT_PATH}/cluster/nodes/{instanceId}`),
        llmsTxt: appPath('/llms.txt'),
        apiDocs: appPath('/api-docs?format=md'),
    };
}

/** Fail closed: without configuration, the known-secret sweep would be incomplete. */
function readRawConfig(): Record<string, unknown> {
    try {
        return getAll();
    } catch {
        throw new DebugReportConfigurationError();
    }
}

function isSetValue(value: unknown): boolean {
    if (typeof value === 'string') return value.trim() !== '';
    return value !== null && value !== undefined && value !== false;
}

/**
 * The one redaction context of a report or a drill-down. The instance ids of the
 * live nodes and the build commit are exempt from the opaque-run pass, so the
 * ids the drill-down links need survive.
 */
async function redactionContext(
    sql: postgres.Sql,
    options: RedactionOptions,
    extraExempt: readonly string[] = [],
    rawConfig: Record<string, unknown> = readRawConfig(),
): Promise<RedactionContext> {
    const roots = await optional('library roots', () => getEnabledLibraryPaths(sql), []);
    const nodes = await optional('cluster nodes', () => readClusterNodes(), []);
    return createRedactionContext({
        options,
        libraryRoots: roots.map((root) => root.path),
        secretValues: collectSecretValues(rawConfig, process.env),
        userinfoPairs: collectUserinfoPairs(rawConfig, process.env),
        exemptOpaque: [
            config.buildInfo.commit,
            config.buildInfo.commitShort,
            ...nodes.map((node) => node.instanceId),
            ...extraExempt,
        ],
    });
}

function redactionNotes(options: RedactionOptions): string[] {
    return [
        'Secrets, tokens, keys and passwords are removed. Config values show only for booleans, numbers and closed choices; every other setting shows set or unset.',
        'Host names, IP addresses, emails and user names are removed or never collected.',
        'Filesystem paths and media file names are removed; library roots show as <library>.',
        'Client diagnostics are aggregates. Summaries in drill-down responses are untrusted client text.',
        options.includeHostnames
            ? 'include=hostnames is on: host names are visible.'
            : 'Host names are not shown.',
        options.includePaths
            ? 'include=paths is on: filesystem paths and media file names are visible.'
            : 'Paths and media file names are not shown.',
    ];
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function installTypeOf(
    env: Readonly<Record<string, string | undefined>>,
): 'kubernetes' | 'container' | 'bare' {
    if (env.KUBERNETES_SERVICE_HOST || env.K8S_NODE_NAME) return 'kubernetes';
    return getRuntimeEnvironment().containerized ? 'container' : 'bare';
}

function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

async function instanceSection(sql: postgres.Sql, ctx: RedactionContext): Promise<ReportInstance> {
    const versions = await getDatabaseVersions(sql);
    const migrations = new MigrationSystem(sql);
    const [current, applied] = await Promise.all([
        migrations.getCurrentVersion(),
        migrations.getAppliedMigrations(),
    ]);
    const appliedVersions = new Set(applied.map((row) => row.version));
    const pending = [...MIGRATIONS]
        .filter(
            (migration) =>
                compareVersions(migration.version, BASE_SCHEMA_VERSION) > 0 &&
                !appliedVersions.has(migration.version),
        )
        .sort((a, b) => compareVersions(a.version, b.version))
        .map((migration) => ({
            version: clean(ctx, migration.version),
            name: clean(ctx, migration.name),
        }));
    const runtime = getRuntimeEnvironment();
    let valkeySplit: boolean | undefined;
    try {
        valkeySplit = hasSeparateCoordinationValkey();
    } catch {
        valkeySplit = undefined;
    }
    return {
        status: 'ok',
        version: clean(ctx, config.buildInfo.version),
        commit: clean(ctx, config.buildInfo.commit),
        commitShort: clean(ctx, config.buildInfo.commitShort),
        buildTime: clean(ctx, config.buildInfo.buildTime),
        installType: installTypeOf(process.env),
        node: {
            version: clean(ctx, runtime.nodeVersion),
            platform: clean(ctx, runtime.platform),
            arch: clean(ctx, runtime.arch),
            containerized: runtime.containerized,
        },
        database: {
            postgresVersion: versions.postgresVersion
                ? clean(ctx, versions.postgresVersion)
                : undefined,
            pgvectorVersion: versions.pgvectorVersion
                ? clean(ctx, versions.pgvectorVersion)
                : undefined,
        },
        valkeySplit,
        migrations: {
            current: clean(ctx, current),
            appliedCount: applied.length,
            pending,
        },
    };
}

async function healthSection(sql: postgres.Sql, ctx: RedactionContext): Promise<ReportHealth> {
    const [ready, componentReport, findingRows] = await Promise.all([
        getReadinessChecks(),
        buildComponentHealth(),
        listFindings(sql),
    ]);

    const components: NonNullable<ReportHealth['components']> = [];
    for (const [name, value] of Object.entries(componentReport)) {
        if (name === 'timestamp' || typeof value !== 'object' || value === null) continue;
        const entry = value as { status?: unknown; reason?: unknown; error?: unknown };
        const status = entry.status === 'pass' || entry.status === 'warn' ? entry.status : 'fail';
        const reason =
            typeof entry.reason === 'string'
                ? entry.reason
                : typeof entry.error === 'string'
                  ? entry.error
                  : undefined;
        components.push({
            name: clean(ctx, name),
            status,
            reason: reason === undefined ? undefined : clean(ctx, reason),
        });
    }

    return {
        status: 'ok',
        ready: {
            orchestrator: ready.orchestrator,
            database: ready.database,
            valkey: ready.valkey,
            cache: ready.cache,
            worker: clean(ctx, String(ready.worker)),
            leader: ready.leader,
        },
        components,
        findings: findingRows.map((row) => ({
            invariantId: clean(ctx, row.invariant_id),
            status: row.status,
            label: clean(ctx, row.label),
            value:
                row.value === null || row.value === undefined
                    ? undefined
                    : clean(ctx, String(row.value)),
            error: row.error ? clean(ctx, row.error) : undefined,
            lastChangeAt: row.last_change_at.toISOString(),
        })),
        href: appPath(`${DEBUG_REPORT_PATH}/health`),
    };
}

function clusterNodeReport(
    ctx: RedactionContext,
    node: LiveClusterNode,
    restarts: { restarts: number; unclean: number } | undefined,
): ReportClusterNode {
    const shortId = node.instanceId.slice(0, 8);
    return {
        name: clean(ctx, `${node.role}-${shortId}`),
        instanceId: clean(ctx, node.instanceId),
        role: clean(ctx, node.role),
        version: clean(ctx, node.version),
        implementation: node.implementation ? clean(ctx, node.implementation) : undefined,
        uptimeSeconds: node.uptimeSeconds,
        heartbeatAgeMs: node.heartbeatAgeMs,
        memoryUsedBytes: node.resources?.memoryUsedBytes,
        memoryLimitBytes: node.resources?.memoryLimitBytes,
        rssBytes: node.process?.rssBytes,
        restarts24h: restarts?.restarts ?? 0,
        uncleanExits24h: restarts?.unclean ?? 0,
        hostname: ctx.options.includeHostnames
            ? clean(ctx, node.host?.name ?? node.hostname)
            : undefined,
        href: appPath(
            `${DEBUG_REPORT_PATH}/cluster/nodes/${encodeURIComponent(clean(ctx, node.instanceId))}`,
        ),
    };
}

async function clusterSection(sql: postgres.Sql, ctx: RedactionContext): Promise<ReportCluster> {
    const nodes = await readClusterNodes({ withHeartbeatAge: true });
    const restarts = await countRestartsSince(sql, {
        instanceIds: nodes.map((node) => node.instanceId),
        hours: WINDOW_HOURS,
    });
    const sidecars = await probeClusterSidecars();
    return {
        status: 'ok',
        nodes: nodes.map((node) => clusterNodeReport(ctx, node, restarts.get(node.instanceId))),
        sidecars: sidecars.map((sidecar) => ({
            name: clean(ctx, sidecar.kind),
            reachable:
                sidecar.state === 'healthy' || sidecar.state === 'degraded'
                    ? ('yes' as const)
                    : ('no' as const),
        })),
    };
}

async function tasksSection(sql: postgres.Sql, ctx: RedactionContext): Promise<ReportTasks> {
    const [failureRows, sampleRows, snapshot, staleRuns, scanRows, pluginRows] = await Promise.all([
        listRunFailureRows(sql, { sinceHours: WINDOW_HOURS }),
        listSampleFailedRuns(sql, { sinceHours: WINDOW_HOURS, perTask: SAMPLE_RUNS_PER_TASK }),
        getLatestSnapshot(sql),
        getStaleInFlightScannerRuns(sql),
        getLatestScannerRunPerLibrary(sql),
        countUnresolvedFailuresByPlugin(sql),
    ]);

    // Rows arrive newest first, so the first row of a task is its latest failure.
    const groups = new Map<string, { count: number; lastAt: Date; firstErrorLine: string }>();
    for (const row of failureRows) {
        const group = groups.get(row.taskId);
        if (group) {
            group.count += 1;
            continue;
        }
        groups.set(row.taskId, {
            count: 1,
            lastAt: row.completedAt,
            firstErrorLine: row.message.split('\n')[0] ?? '',
        });
    }

    const samplesByTask = new Map<string, Array<{ runId: string; href: string }>>();
    for (const sample of sampleRows) {
        if (!RUN_ID_RE.test(sample.runId)) continue;
        const list = samplesByTask.get(sample.taskId) ?? [];
        list.push({
            runId: sample.runId,
            href: appPath(`${DEBUG_REPORT_PATH}/runs/${encodeURIComponent(sample.runId)}`),
        });
        samplesByTask.set(sample.taskId, list);
    }

    const failedRuns = [...groups.entries()]
        .map(([taskId, group]) => ({
            taskId: clean(ctx, taskId),
            count: group.count,
            lastAt: group.lastAt.toISOString(),
            firstErrorLine: clean(ctx, group.firstErrorLine),
            sampleRuns: (samplesByTask.get(taskId) ?? []).slice(0, SAMPLE_RUNS_PER_TASK),
        }))
        .sort((a, b) => b.count - a.count || a.taskId.localeCompare(b.taskId));

    const sum = (values: Record<string, number>): number =>
        Object.values(values).reduce((total, value) => total + value, 0);

    return {
        status: 'ok',
        failedRuns,
        queue: snapshot
            ? {
                  depth: sum(snapshot.queueDepth),
                  activeRuns: sum(snapshot.activeRuns),
                  snapshotAt: isoOf(snapshot.ts),
              }
            : undefined,
        staleScans: staleRuns.length,
        lastScans: scanRows.map((row) => ({
            libraryPathId: row.library_path_id ? clean(ctx, row.library_path_id) : undefined,
            startedAt: row.started_at.toISOString(),
            completedAt: row.completed_at ? row.completed_at.toISOString() : undefined,
            totalFiles: row.total_files,
            matched: row.matched,
            updated: row.updated,
            unmatched: row.unmatched,
            errors: row.errors,
            path:
                ctx.options.includePaths && row.library_path
                    ? clean(ctx, row.library_path)
                    : undefined,
        })),
        pluginFailures: pluginRows.map((row) => ({
            pluginId: clean(ctx, row.pluginId),
            count: row.count,
        })),
    };
}

async function librarySection(sql: postgres.Sql, ctx: RedactionContext): Promise<ReportLibrary> {
    const [issues, violations] = await Promise.all([
        countMediaHealthIssuesByType(sql),
        countOpenViolationsByRule(sql),
    ]);
    return {
        status: 'ok',
        mediaHealthIssues: issues.map((row) => ({
            type: clean(ctx, row.type ?? 'unknown'),
            count: row.count,
        })),
        integrityViolations: Object.entries(violations)
            .map(([rule, count]) => ({ rule: clean(ctx, rule), count }))
            .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)),
    };
}

/** Fingerprints are validated opaque ids, not arbitrary credential-shaped text. */
function reportFingerprint(ctx: RedactionContext, fingerprint: string): string {
    return fingerprint === 'none' || FINGERPRINT_RE.test(fingerprint)
        ? fingerprint
        : clean(ctx, fingerprint);
}

async function clientDiagnosticsSection(
    sql: postgres.Sql,
    ctx: RedactionContext,
): Promise<ReportClientDiagnostics> {
    const rows = await summarizeClientDiagnostics(sql, { sinceHours: WINDOW_HOURS });
    return {
        status: 'ok',
        windowHours: WINDOW_HOURS,
        groups: rows.map((row) => ({
            fingerprint: reportFingerprint(ctx, row.fingerprint),
            kind: clean(ctx, row.kind),
            platform: clean(ctx, row.platform),
            appVersion: row.appVersion ? clean(ctx, row.appVersion) : undefined,
            count: row.count,
            firstSeen: row.firstSeen.toISOString(),
            lastSeen: row.lastSeen.toISOString(),
            href: appPath(
                `${DEBUG_REPORT_PATH}/client-diagnostics/${encodeURIComponent(reportFingerprint(ctx, row.fingerprint))}`,
            ),
        })),
    };
}

function settingsSection(
    ctx: RedactionContext,
    rawConfig: Record<string, unknown>,
): ReportSettings {
    const state = getConfigState();
    return {
        status: 'ok',
        entries: redactConfigForReport(
            rawConfig,
            {
                envOverrides: state?.envOverrides ?? new Set<string>(),
                jsonOverrides: state?.jsonOverrides ?? new Set<string>(),
            },
            ctx,
        ),
    };
}

/** Integration name to the provider check that probes it (see `provider-health.ts`). */
const CONNECTION_PROVIDER: Readonly<Record<string, string>> = {
    Jellyfin: 'jellyfin',
    Audiobookshelf: 'audiobookshelf',
    Kavita: 'kavita',
    Sonarr: 'sonarr',
    Radarr: 'radarr',
    Seerr: 'jellyseerr',
    Trakt: 'trakt',
};

/** Metadata providers with an API key, probed the same way. */
const METADATA_PROVIDERS: ReadonlyArray<{ name: string; provider: string; key: string }> = [
    { name: 'TMDB', provider: 'tmdb', key: 'TMDB_API_KEY' },
    { name: 'MDBList', provider: 'mdblist', key: 'MDBLIST_API_KEY' },
    { name: 'OpenAI', provider: 'openai', key: 'OPENAI_API_KEY' },
    { name: 'Voyage AI', provider: 'voyage', key: 'VOYAGE_API_KEY' },
];

/**
 * Whether a provider answers, cached in Valkey for five minutes (spec §4.8).
 * The cache entry holds only the boolean. A timeout or an error is "no".
 */
type Reachability = 'yes' | 'no' | 'not_checked';
const probeFlights = new Map<string, Promise<Reachability>>();
const probeCache = new Map<string, { result: Reachability; expiresAt: number }>();

async function probeReachable(provider: string): Promise<Reachability> {
    if (!hasHealthCheck(provider)) return 'not_checked';
    const local = probeCache.get(provider);
    if (local && local.expiresAt > Date.now()) return local.result;
    const flight = probeFlights.get(provider);
    if (flight) return flight;

    const pending = probeAndCache(provider).finally(() => probeFlights.delete(provider));
    probeFlights.set(provider, pending);
    return pending;
}

async function probeAndCache(provider: string): Promise<Reachability> {
    const key = `${PROBE_CACHE_PREFIX}${provider}`;
    const remember = (reachable: boolean): Reachability => {
        const result = reachable ? 'yes' : 'no';
        probeCache.set(provider, {
            result,
            expiresAt: Date.now() + PROBE_CACHE_TTL_SECONDS * 1000,
        });
        return result;
    };
    try {
        const cached = await cacheGet(key);
        if (cached !== null) {
            const parsed = JSON.parse(cached) as { reachable?: unknown };
            if (typeof parsed.reachable === 'boolean') return remember(parsed.reachable);
        }
    } catch {
        // The in-process cache still bounds probes when Valkey is unavailable.
    }

    const reachable = await withTimeout(
        runProviderHealthCheck(provider, undefined, AbortSignal.timeout(PROBE_TIMEOUT_MS)),
        PROBE_TIMEOUT_MS,
    )
        .then((outcome) => outcome.healthy || outcome.rateLimited === true)
        .catch(() => false);
    const result = remember(reachable);
    try {
        await cacheSet(key, JSON.stringify({ reachable }), PROBE_CACHE_TTL_SECONDS);
    } catch {
        // The local TTL was set before writing to Valkey.
    }
    return result;
}

function stateReachable(state: string): 'yes' | 'no' | 'not_checked' {
    if (state === 'connected') return 'yes';
    if (state === 'disconnected') return 'no';
    return 'not_checked';
}

async function integrationsSection(
    ctx: RedactionContext,
    rawConfig: Record<string, unknown>,
): Promise<ReportIntegrations> {
    const connections = connectionStatuses();
    const connectionItems = await Promise.all(
        connections.map(async (connection) => {
            const provider = CONNECTION_PROVIDER[connection.name];
            // Jellyfin reports its own connection state; the rest are probed when configured.
            const fromState =
                connection.name === 'Jellyfin'
                    ? stateReachable(connectionStatus.getStatus('jellyfin').state)
                    : 'not_checked';
            const reachable =
                fromState === 'not_checked' && connection.configured && provider
                    ? await probeReachable(provider)
                    : fromState;
            return {
                name: clean(ctx, connection.name),
                configured: connection.configured,
                reachable,
            };
        }),
    );
    const metadataItems = await Promise.all(
        METADATA_PROVIDERS.map(async (entry) => {
            const configured = isSetValue(rawConfig[entry.key]);
            return {
                name: entry.name,
                configured,
                reachable: configured
                    ? await probeReachable(entry.provider)
                    : ('not_checked' as const),
            };
        }),
    );
    const databaseItem = {
        name: 'PostgreSQL',
        configured: true,
        reachable: stateReachable(connectionStatus.getStatus('postgres').state),
    };
    const valkeyState = connectionStatus.getStatus('valkey').state;
    const valkeyItem = {
        name: 'Valkey',
        configured: valkeyState !== 'not_configured',
        reachable: stateReachable(valkeyState),
    };
    const items = [...connectionItems, ...metadataItems, databaseItem, valkeyItem].sort((a, b) =>
        a.name.localeCompare(b.name),
    );
    return { status: 'ok', items };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * Assemble the whole report. Every section is independent: a failing source
 * yields `status: 'unavailable'` for that section only.
 */
export async function buildDebugReport(
    sql: postgres.Sql,
    opts: { options: RedactionOptions },
): Promise<DebugReport> {
    const rawConfig = readRawConfig();
    const ctx = await redactionContext(sql, opts.options, [], rawConfig);
    const generatedAt = new Date().toISOString();

    const healthHref = appPath(`${DEBUG_REPORT_PATH}/health`);
    const sections: ReportSections = {
        links: reportLinks(),
        instance: await collect(
            'instance',
            () => instanceSection(sql, ctx),
            (note) => ({ status: 'unavailable', note }),
        ),
        health: await collect(
            'health',
            () => healthSection(sql, ctx),
            (note) => ({ status: 'unavailable', note, href: healthHref }),
        ),
        cluster: await collect(
            'cluster',
            () => clusterSection(sql, ctx),
            (note) => ({ status: 'unavailable', note }),
        ),
        tasks: await collect(
            'tasks',
            () => tasksSection(sql, ctx),
            (note) => ({ status: 'unavailable', note }),
        ),
        library: await collect(
            'library',
            () => librarySection(sql, ctx),
            (note) => ({ status: 'unavailable', note }),
        ),
        serverErrors: {
            status: 'unavailable',
            note: 'No in-process server error collector exists yet. Read the container log or the log backend for error signatures.',
        },
        clientDiagnostics: await collect(
            'client diagnostics',
            () => clientDiagnosticsSection(sql, ctx),
            (note) => ({ status: 'unavailable', note, windowHours: WINDOW_HOURS }),
        ),
        settings: await collect(
            'settings',
            async () => settingsSection(ctx, rawConfig),
            (note) => ({ status: 'unavailable', note }),
        ),
        integrations: await collect(
            'integrations',
            () => integrationsSection(ctx, rawConfig),
            (note) => ({ status: 'unavailable', note }),
        ),
    };

    return finalizeReport({ schemaVersion: 1 as const, generatedAt, ...sections }, ctx);
}

/** Sweep every result and expose the same hit accounting on reports and drill-downs. */
function finalizeReport<T>(
    report: T,
    ctx: RedactionContext,
): T & { redaction: DebugReport['redaction'] } {
    const asserted = assertNoSecrets(report, ctx);
    if (asserted.hits > 0) {
        logger.error(
            `Debug report: ${asserted.hits} known-secret hit(s) reached the final assertion; a section bypassed the redactor`,
        );
    }

    return {
        ...asserted.report,
        redaction: {
            options: { ...ctx.options },
            counts: { ...ctx.counts },
            secretSweepHits: asserted.hits,
            notes: redactionNotes(ctx.options),
        },
    };
}

// ---------------------------------------------------------------------------
// Drill-downs
// ---------------------------------------------------------------------------

function stringOf(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

/** One failed run with its redacted error and last log lines. Null when not found. */
export async function buildRunDetail(sql: postgres.Sql, runId: string): Promise<RunDetail | null> {
    if (!RUN_ID_RE.test(runId)) return null;
    const ctx = await redactionContext(sql, NO_INCLUDE, [runId]);
    const found = await orchestrator.getRun(runId);
    // The orchestrator has only these two terminal failure states.
    if (!found || (found.state !== 'failed' && found.state !== 'cancelled')) return null;
    const run = toPublicRun(found) as unknown as Record<string, unknown>;
    const logs = await optional('run logs', () => logBuffer.readRecent(runId, RUN_LOG_LINES), []);

    const startedAt = isoOf(run.startedAt);
    const completedAt = isoOf(run.completedAt);
    const durationMs =
        startedAt && completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : undefined;

    let error: RunDetail['run']['error'];
    if (run.error && typeof run.error === 'object') {
        const raw = run.error as { message?: unknown; kind?: unknown };
        if (typeof raw.message === 'string') {
            error = {
                message: clean(ctx, raw.message),
                kind: typeof raw.kind === 'string' ? clean(ctx, raw.kind) : undefined,
            };
        }
    }

    return finalizeReport<RunDetail>(
        {
            run: {
                id: clean(ctx, stringOf(run.id) ?? runId),
                taskId: clean(ctx, stringOf(run.taskId) ?? 'unknown'),
                state: clean(ctx, stringOf(run.state) ?? 'unknown'),
                createdAt: isoOf(run.createdAt),
                startedAt,
                completedAt,
                durationMs:
                    durationMs !== undefined && Number.isFinite(durationMs)
                        ? durationMs
                        : undefined,
                error,
            },
            logs: logs.map((entry) => ({
                ts: isoOfMillis(entry.ts) ?? '',
                level: entry.level,
                msg: untrusted(ctx, entry.message),
            })),
            pasteSafe: false,
        },
        ctx,
    );
}

/** One client-diagnostic group: recent events, summaries untrusted. Null when not found. */
export async function buildClientDiagnosticGroup(
    sql: postgres.Sql,
    fingerprint: string,
): Promise<ClientDiagnosticGroupDetail | null> {
    if (fingerprint !== 'none' && !FINGERPRINT_RE.test(fingerprint)) return null;
    const ctx = await redactionContext(sql, NO_INCLUDE);
    const rows = await listClientDiagnosticGroup(sql, fingerprint, {
        limit: CLIENT_GROUP_EVENTS,
        sinceHours: WINDOW_HOURS,
    });
    if (rows.length === 0) return null;

    return finalizeReport<ClientDiagnosticGroupDetail>(
        {
            fingerprint,
            windowHours: WINDOW_HOURS,
            items: rows.map((row) => ({
                occurredAt: row.occurredAt.toISOString(),
                kind: clean(ctx, row.kind),
                platform: clean(ctx, row.platform),
                appVersion: row.appVersion ? clean(ctx, row.appVersion) : undefined,
                osVersion: row.osVersion ? clean(ctx, row.osVersion) : undefined,
                summary: row.summary ? untrusted(ctx, row.summary) : undefined,
            })),
            pasteSafe: false,
        },
        ctx,
    );
}

/** One cluster node: live resources (when live) and its recent events. Null when unknown. */
export async function buildClusterNodeDetail(
    sql: postgres.Sql,
    instanceId: string,
): Promise<ClusterNodeDetail | null> {
    if (!INSTANCE_ID_RE.test(instanceId)) return null;
    const ctx = await redactionContext(sql, NO_INCLUDE, [instanceId]);
    const nodes = await readClusterNodes({ withHeartbeatAge: true });
    const node = nodes.find((candidate) => candidate.instanceId === instanceId);
    const restarts = (
        await countRestartsSince(sql, { instanceIds: [instanceId], hours: WINDOW_HOURS })
    ).get(instanceId);
    const events = await getNodeTimeline(sql, { instanceId, limit: NODE_EVENTS });
    if (!node && events.length === 0) return null;

    const role = node?.role ?? events[0]?.role ?? 'unknown';
    return finalizeReport<ClusterNodeDetail>(
        {
            name: clean(ctx, `${role}-${instanceId.slice(0, 8)}`),
            instanceId: clean(ctx, instanceId),
            role: clean(ctx, role),
            version: node ? clean(ctx, node.version) : undefined,
            live: node !== undefined,
            uptimeSeconds: node?.uptimeSeconds,
            heartbeatAgeMs: node?.heartbeatAgeMs,
            memoryUsedBytes: node?.resources?.memoryUsedBytes,
            memoryLimitBytes: node?.resources?.memoryLimitBytes,
            rssBytes: node?.process?.rssBytes,
            restarts24h: restarts?.restarts ?? 0,
            uncleanExits24h: restarts?.unclean ?? 0,
            events: events.map((event) => ({
                at: event.createdAt.toISOString(),
                eventType: clean(ctx, event.eventType),
                role: event.role ? clean(ctx, event.role) : undefined,
                version: event.version ? clean(ctx, event.version) : undefined,
            })),
        },
        ctx,
    );
}

/** Readiness, component reasons and health findings, current. */
export async function buildHealthDetail(sql: postgres.Sql): Promise<ReportHealth> {
    const ctx = await redactionContext(sql, NO_INCLUDE);
    const health = await collect<ReportHealth>(
        'health',
        () => healthSection(sql, ctx),
        (note) => ({ status: 'unavailable', note, href: appPath(`${DEBUG_REPORT_PATH}/health`) }),
    );
    return finalizeReport(health, ctx);
}
