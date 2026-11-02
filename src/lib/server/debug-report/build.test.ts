// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The debug report producer (spec 2026-10-21-admin-debug-report-design §5, §7).
 *
 * Every data source is mocked and seeded with unique markers: a sensitive config
 * value echoed inside a run error, a readiness reason with an internal host, a
 * client summary with an email and a JWT, a cluster host name, a scanner path, an
 * Xtream URL inside a finding. No marker may reach the JSON or the Markdown by
 * default. The include toggles reveal hosts and paths only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';
import { configSchema } from '$lib/config/schema';
import { DebugReportSchema } from '$lib/schemas/debug-report.js';
import { DebugReportConfigurationError } from './errors.js';
import { formatDebugReport } from '$lib/shared/debug-report-format.js';

const SECRET = 'tmdb-secret-marker-9981';
const HOOK_SECRET = 'HOOKSECRET123';
const ENV_TOKEN = 'envtoken-marker-7731';
// The orchestrator's real id shape (run_ + ULID): the free-text pass would take it for an opaque secret.
const RUN_ID = 'run_01M5DJK7TRMHQZ56K4JWDZ7F9A';
const FINGERPRINT = '0123456789abcdef0123456789abcdef';

const mocks = vi.hoisted(() => ({
    buildInfo: { version: '', commit: '', commitShort: '', buildTime: '', branch: '' },
    migrations: [
        { version: '16.303.0', name: 'applied_one', description: '', checksum: '' },
        { version: '16.413.0', name: 'pending_one', description: '', checksum: '' },
    ],
    getRuntimeEnvironment: vi.fn(),
    getAll: vi.fn(),
    getConfigState: vi.fn(),
    currentVersion: vi.fn(),
    appliedMigrations: vi.fn(),
    getEnabledLibraryPaths: vi.fn(),
    listFindings: vi.fn(),
    countRestartsSince: vi.fn(),
    getNodeTimeline: vi.fn(),
    listRunFailureRows: vi.fn(),
    listSampleFailedRuns: vi.fn(),
    getLatestSnapshot: vi.fn(),
    getStaleInFlightScannerRuns: vi.fn(),
    getLatestScannerRunPerLibrary: vi.fn(),
    countUnresolvedFailuresByPlugin: vi.fn(),
    countOpenViolationsByRule: vi.fn(),
    summarizeClientDiagnostics: vi.fn(),
    listClientDiagnosticGroup: vi.fn(),
    countMediaHealthIssuesByType: vi.fn(),
    getDatabaseVersions: vi.fn(),
    getReadinessChecks: vi.fn(),
    buildComponentHealth: vi.fn(),
    readClusterNodes: vi.fn(),
    probeClusterSidecars: vi.fn(),
    getStatus: vi.fn(),
    connectionStatuses: vi.fn(),
    hasHealthCheck: vi.fn(),
    runProviderHealthCheck: vi.fn(),
    cacheGet: vi.fn(),
    cacheSet: vi.fn(),
    getRun: vi.fn(),
    readRecent: vi.fn(),
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        buildInfo: mocks.buildInfo,
        INSTANCE_ID: 'web-abcdef12-3456',
    },
    features: {},
}));
vi.mock('$lib/server/utils/runtime-environment.js', () => ({
    getRuntimeEnvironment: (...args: unknown[]) => mocks.getRuntimeEnvironment(...args),
}));
vi.mock('$lib/server/config/config.service.js', () => ({
    getAll: (...args: unknown[]) => mocks.getAll(...args),
    getConfigState: (...args: unknown[]) => mocks.getConfigState(...args),
}));
vi.mock('$lib/server/database/migrate-schema.js', () => ({
    MIGRATIONS: mocks.migrations,
}));
vi.mock('$lib/server/database/base-schema.js', () => ({ BASE_SCHEMA_VERSION: '16.302.0' }));
vi.mock('$lib/server/database/migration-system.js', () => ({
    MigrationSystem: class {
        getCurrentVersion(): Promise<string> {
            return mocks.currentVersion();
        }
        getAppliedMigrations(): Promise<unknown[]> {
            return mocks.appliedMigrations();
        }
    },
}));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths: (...args: unknown[]) => mocks.getEnabledLibraryPaths(...args),
}));
vi.mock('$lib/server/database/queries/health-check-findings.queries.js', () => ({
    listFindings: (...args: unknown[]) => mocks.listFindings(...args),
}));
vi.mock('$lib/server/database/queries/cluster-nodes.queries.js', () => ({
    countRestartsSince: (...args: unknown[]) => mocks.countRestartsSince(...args),
    getNodeTimeline: (...args: unknown[]) => mocks.getNodeTimeline(...args),
}));
vi.mock('$lib/server/database/queries/failure-patterns.queries.js', () => ({
    listRunFailureRows: (...args: unknown[]) => mocks.listRunFailureRows(...args),
}));
vi.mock('$lib/server/database/queries/task-metrics-snapshot.queries.js', () => ({
    getLatestSnapshot: (...args: unknown[]) => mocks.getLatestSnapshot(...args),
}));
vi.mock('$lib/server/database/queries/file-scanner-runs.queries.js', () => ({
    getStaleInFlightScannerRuns: (...args: unknown[]) => mocks.getStaleInFlightScannerRuns(...args),
    getLatestScannerRunPerLibrary: (...args: unknown[]) =>
        mocks.getLatestScannerRunPerLibrary(...args),
}));
vi.mock('$lib/server/database/queries/plugin-failure-events.queries.js', () => ({
    countUnresolvedFailuresByPlugin: (...args: unknown[]) =>
        mocks.countUnresolvedFailuresByPlugin(...args),
}));
vi.mock('$lib/server/database/queries/integrity-violations.queries.js', () => ({
    countOpenViolationsByRule: (...args: unknown[]) => mocks.countOpenViolationsByRule(...args),
}));
vi.mock('$lib/server/database/queries/client-diagnostics.queries.js', () => ({
    summarizeClientDiagnostics: (...args: unknown[]) => mocks.summarizeClientDiagnostics(...args),
    listClientDiagnosticGroup: (...args: unknown[]) => mocks.listClientDiagnosticGroup(...args),
}));
vi.mock('$lib/server/database/queries/debug-report.queries.js', () => ({
    countMediaHealthIssuesByType: (...args: unknown[]) =>
        mocks.countMediaHealthIssuesByType(...args),
    getDatabaseVersions: (...args: unknown[]) => mocks.getDatabaseVersions(...args),
    listSampleFailedRuns: (...args: unknown[]) => mocks.listSampleFailedRuns(...args),
}));
vi.mock('$lib/server/health/readiness-checks.js', () => ({
    getReadinessChecks: (...args: unknown[]) => mocks.getReadinessChecks(...args),
}));
vi.mock('$lib/server/health/component-health.js', () => ({
    buildComponentHealth: (...args: unknown[]) => mocks.buildComponentHealth(...args),
}));
vi.mock('$lib/server/services/cluster-heartbeat.service.js', () => ({
    readClusterNodes: (...args: unknown[]) => mocks.readClusterNodes(...args),
}));
vi.mock('$lib/server/services/cluster-sidecar-probe.js', () => ({
    probeClusterSidecars: (...args: unknown[]) => mocks.probeClusterSidecars(...args),
}));
vi.mock('$lib/server/services/connection-status.service.js', () => ({
    connectionStatus: { getStatus: (...args: unknown[]) => mocks.getStatus(...args) },
}));
vi.mock('$lib/server/admin/connection-status.js', () => ({
    connectionStatuses: (...args: unknown[]) => mocks.connectionStatuses(...args),
}));
vi.mock('$lib/server/admin/provider-health.js', () => ({
    hasHealthCheck: (...args: unknown[]) => mocks.hasHealthCheck(...args),
    runProviderHealthCheck: (...args: unknown[]) => mocks.runProviderHealthCheck(...args),
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    cacheGet: (...args: unknown[]) => mocks.cacheGet(...args),
    cacheSet: (...args: unknown[]) => mocks.cacheSet(...args),
    hasSeparateCoordinationValkey: () => false,
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { getRun: (...args: unknown[]) => mocks.getRun(...args) },
}));
vi.mock('$lib/server/tasks/log-buffer.js', () => ({
    logBuffer: { readRecent: (...args: unknown[]) => mocks.readRecent(...args) },
}));
vi.mock('$lib/server/tasks/run-event.js', () => ({
    toPublicRun: (run: {
        error?: { message: string; kind?: unknown; stack?: string };
        [key: string]: unknown;
    }) => {
        const { error, ...rest } = run;
        return error ? { ...rest, error: { message: error.message, kind: error.kind } } : rest;
    },
}));

import {
    buildClientDiagnosticGroup,
    buildClusterNodeDetail,
    buildDebugReport,
    buildHealthDetail,
    buildRunDetail,
} from './build.js';

const sql = {} as unknown as postgres.Sql;
const NO_INCLUDE = { includeHostnames: false, includePaths: false };
const WITH_HOSTS = { includeHostnames: true, includePaths: false };
const WITH_PATHS = { includeHostnames: false, includePaths: true };

const FORBIDDEN_BY_DEFAULT = [
    SECRET,
    ENV_TOKEN,
    HOOK_SECRET,
    'hooks.example.test',
    'hunter2pass',
    'pass456',
    'user123',
    'xtream.example.test',
    'db.internal',
    'worker-7',
    'cluster.local',
    '/mnt/media',
    'Film (1999)',
    'foo@example.com',
    'eyJhbGciOi',
    'feature/secret-branch-x',
];

function seedSources(): void {
    Object.assign(mocks.buildInfo, {
        version: '0.1.0',
        commit: 'abcdef1234567890abcdef1234567890abcdef12',
        commitShort: 'abcdef1',
        buildTime: '2026-10-21T00:00:00.000Z',
        branch: 'feature/secret-branch-x',
    });
    mocks.migrations[1]!.version = '16.413.0';
    mocks.migrations[1]!.name = 'pending_one';
    mocks.getRuntimeEnvironment.mockReturnValue({
        nodeVersion: 'v22.0.0',
        platform: 'linux',
        arch: 'x64',
        containerized: false,
    });
    mocks.getAll.mockReturnValue({
        TMDB_API_KEY: SECRET,
        DATE_LOCALE: 'en-US',
        JELLYFINURL: 'http://jf.internal:8096',
    });
    mocks.getConfigState.mockReturnValue({
        values: {},
        envOverrides: new Set(['TMDB_API_KEY']),
        jsonOverrides: new Set(['DATE_LOCALE']),
        loadedAt: new Date('2026-10-21T00:00:00.000Z'),
    });
    mocks.currentVersion.mockResolvedValue('16.412.0');
    mocks.appliedMigrations.mockResolvedValue([
        { version: '16.303.0', name: 'applied_one', applied_at: new Date() },
    ]);
    mocks.getEnabledLibraryPaths.mockResolvedValue([{ path: '/mnt/media' }]);
    mocks.getDatabaseVersions.mockResolvedValue({
        postgresVersion: 'PostgreSQL 18.1',
        pgvectorVersion: '0.8.0',
    });
    mocks.getReadinessChecks.mockResolvedValue({
        orchestrator: true,
        database: true,
        valkey: true,
        cache: 'disabled',
        worker: 'absent',
        leader: false,
    });
    mocks.buildComponentHealth.mockResolvedValue({
        timestamp: '2026-10-21T10:00:00.000Z',
        database: { status: 'fail', reason: 'ECONNREFUSED db.internal:5432' },
        valkey: { status: 'pass' },
    });
    mocks.listFindings.mockResolvedValue([
        {
            invariant_id: 'library_writable',
            status: 'red',
            value: '0',
            label: 'Library writable',
            description: '',
            remediation: null,
            threshold_amber: null,
            threshold_red: null,
            last_run_at: new Date('2026-10-21T10:00:00.000Z'),
            last_change_at: new Date('2026-10-21T09:00:00.000Z'),
            last_value_at: new Date('2026-10-21T10:00:00.000Z'),
            error: `fetch https://user:hunter2pass@xtream.example.test:8080/live/user123/pass456/12.ts failed`,
            details: null,
        },
    ]);
    mocks.readClusterNodes.mockResolvedValue([
        {
            instanceId: 'web-abcdef12-3456',
            role: 'web',
            version: '0.1.0',
            hostname: 'worker-7.cluster.local',
            startedAt: '2026-10-21T09:00:00.000Z',
            uptimeSeconds: 3600,
            keyFingerprint: '',
            resources: { memoryUsedBytes: 100_000_000, memoryLimitBytes: 200_000_000 },
            process: { rssBytes: 50_000_000 },
            heartbeatAgeMs: 1200,
            host: { id: 'host-1', name: 'worker-7.cluster.local' },
        },
    ]);
    mocks.countRestartsSince.mockResolvedValue(
        new Map([['web-abcdef12-3456', { restarts: 2, unclean: 1 }]]),
    );
    mocks.probeClusterSidecars.mockResolvedValue([
        { kind: 'sonic', state: 'healthy', checkedAt: '2026-10-21T10:00:00.000Z' },
    ]);
    mocks.listRunFailureRows.mockResolvedValue([
        {
            taskId: 'sonic-embedding-backfill',
            message: `Upstream rejected ${SECRET} at /mnt/media/Film (1999)/a.mkv via https://hooks.example.test/hook/${HOOK_SECRET}`,
            kind: 'Error',
            completedAt: new Date('2026-10-21T10:00:00.000Z'),
        },
        {
            taskId: 'sonic-embedding-backfill',
            message: 'second failure',
            kind: 'Error',
            completedAt: new Date('2026-10-21T08:00:00.000Z'),
        },
    ]);
    mocks.listSampleFailedRuns.mockResolvedValue([
        {
            runId: RUN_ID,
            taskId: 'sonic-embedding-backfill',
            completedAt: new Date('2026-10-21T10:00:00.000Z'),
        },
    ]);
    mocks.getLatestSnapshot.mockResolvedValue({
        id: 1,
        ts: '2026-10-21T10:00:00.000Z',
        instanceId: 'web-abcdef12-3456',
        queueDepth: { a: 2, b: 3 },
        activeRuns: { a: 1 },
        durationP50Ms: null,
        durationP95Ms: null,
        runsCompleted: 0,
        runsFailed: 0,
        openCircuits: 0,
    });
    mocks.getStaleInFlightScannerRuns.mockResolvedValue([]);
    mocks.getLatestScannerRunPerLibrary.mockResolvedValue([
        {
            id: 's1',
            library_path_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            started_at: new Date('2026-10-21T09:00:00.000Z'),
            completed_at: new Date('2026-10-21T09:30:00.000Z'),
            total_files: 10,
            matched: 8,
            updated: 2,
            unmatched: 2,
            errors: 0,
            match_rate: '80',
            error_samples: [],
            created_at: new Date('2026-10-21T09:00:00.000Z'),
            library_path: '/mnt/media/Film (1999)/a.mkv',
        },
    ]);
    mocks.countUnresolvedFailuresByPlugin.mockResolvedValue([
        { pluginId: 'fribb-anime-sync', count: 2 },
    ]);
    mocks.countOpenViolationsByRule.mockResolvedValue({ orphan_file: 3 });
    mocks.countMediaHealthIssuesByType.mockResolvedValue([
        { type: 'missing_file', count: 4 },
        { type: null, count: 1 },
    ]);
    mocks.summarizeClientDiagnostics.mockResolvedValue([
        {
            kind: 'playback_incident',
            platform: 'tvos',
            appVersion: '1.2.3',
            fingerprint: FINGERPRINT,
            count: 4,
            firstSeen: new Date('2026-10-21T08:00:00.000Z'),
            lastSeen: new Date('2026-10-21T10:00:00.000Z'),
        },
    ]);
    mocks.listClientDiagnosticGroup.mockResolvedValue([
        {
            occurredAt: new Date('2026-10-21T10:00:00.000Z'),
            kind: 'playback_incident',
            platform: 'tvos',
            appVersion: '1.2.3',
            osVersion: '26.0',
            summary:
                'user foo@example.com token eyJhbGciOi.eyJzdWIi.abcdefghijklmnop with key sk-ant-XXXXXXXXXXXXXXXX',
        },
    ]);
    mocks.connectionStatuses.mockReturnValue([
        { section: 'conn-jellyfin', name: 'Jellyfin', configured: true },
        { section: 'conn-trakt', name: 'Trakt', configured: false },
    ]);
    mocks.getStatus.mockReturnValue({
        state: 'connected',
        lastCheck: null,
        lastError: null,
        retryCount: 0,
    });
    mocks.hasHealthCheck.mockReturnValue(true);
    mocks.runProviderHealthCheck.mockResolvedValue({
        healthy: true,
        latencyMs: 1,
        checkable: true,
    });
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue(true);
    mocks.getRun.mockResolvedValue({
        id: RUN_ID,
        taskId: 'sonic-embedding-backfill',
        state: 'failed',
        createdAt: new Date('2026-10-21T09:59:00.000Z'),
        startedAt: new Date('2026-10-21T09:59:10.000Z'),
        completedAt: new Date('2026-10-21T10:00:00.000Z'),
        trigger: { kind: 'schedule', idempotencyKey: 'key-secret' },
        error: {
            message: `Upstream rejected ${SECRET} at /mnt/media/Film (1999)/a.mkv`,
            kind: 'Error',
            stack: 'Error: boom\n    at /mnt/media/Film (1999)/a.mkv:1:1',
        },
    });
    mocks.readRecent.mockResolvedValue([
        {
            ts: 1_761_040_000_000,
            level: 'error',
            message: `failed with ${SECRET} and key=${HOOK_SECRET} env ${ENV_TOKEN}`,
            meta: { extra: 'DROP ME', path: '/mnt/media/Film (1999)/a.mkv' },
        },
    ]);
    mocks.getNodeTimeline.mockResolvedValue([
        {
            id: 'e1',
            instanceId: 'web-abcdef12-3456',
            eventType: 'online',
            role: 'web',
            version: '0.1.0',
            hostname: 'worker-7.cluster.local',
            createdAt: new Date('2026-10-21T09:00:00.000Z'),
        },
    ]);
}

let testTime = Date.parse('2035-01-01T00:00:00Z');

beforeEach(() => {
    vi.clearAllMocks();
    // Expire the process cache between tests without adding a production reset API.
    testTime += 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(testTime);
    vi.stubEnv('LUMASTRA_TEST_TOKEN', ENV_TOKEN);
    seedSources();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('buildDebugReport: redaction', () => {
    it('keeps every seeded marker out of the JSON and the Markdown by default', async () => {
        const report = await buildDebugReport(sql, { options: NO_INCLUDE });
        const json = JSON.stringify(report);
        const markdown = formatDebugReport(report);
        for (const marker of FORBIDDEN_BY_DEFAULT) {
            expect(json, `JSON leaks ${marker}`).not.toContain(marker);
            expect(markdown, `Markdown leaks ${marker}`).not.toContain(marker);
        }
    });

    it('needs no final-assertion rescue: every section passed the redactor', async () => {
        const report = await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(report.redaction.secretSweepHits).toBe(0);
    });

    it('shows a host name only with include=hostnames, in the JSON host field', async () => {
        const plain = JSON.stringify(await buildDebugReport(sql, { options: NO_INCLUDE }));
        expect(plain).not.toContain('"hostname"');
        expect(plain).not.toContain('worker-7');

        const withHosts = await buildDebugReport(sql, { options: WITH_HOSTS });
        expect(withHosts.cluster.nodes?.[0]?.hostname).toBe('worker-7.cluster.local');
        expect(formatDebugReport(withHosts)).toContain('include=hostnames is on');
    });

    it('shows a filesystem path only with include=paths', async () => {
        const plain = JSON.stringify(await buildDebugReport(sql, { options: NO_INCLUDE }));
        expect(plain).not.toContain('Film (1999)');

        const withPaths = await buildDebugReport(sql, { options: WITH_PATHS });
        expect(withPaths.tasks.lastScans?.[0]?.path).toBe('/mnt/media/Film (1999)/a.mkv');
        expect(formatDebugReport(withPaths)).toContain('include=paths is on');
    });

    it('marks client summaries and log lines as untrusted and redacts them', async () => {
        const groupDetail = await buildClientDiagnosticGroup(sql, FINGERPRINT);
        const groupJson = JSON.stringify(groupDetail);
        expect(groupJson).not.toContain('foo@example.com');
        expect(groupJson).not.toContain('eyJhbGciOi');
        expect(groupJson).not.toContain('sk-ant-');
        expect(groupDetail?.items[0]?.summary?.untrusted).toBe(true);
        expect(groupDetail?.pasteSafe).toBe(false);

        const runDetail = await buildRunDetail(sql, RUN_ID);
        expect(runDetail?.logs[0]?.msg.untrusted).toBe(true);
        expect(JSON.stringify(runDetail)).not.toContain(SECRET);
    });
});

describe('buildDebugReport: sections', () => {
    it('a failing source yields unavailable for its section only', async () => {
        mocks.listFindings.mockRejectedValueOnce(new Error('connection refused db.internal'));
        const report = await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(report.health.status).toBe('unavailable');
        expect(report.health.note).toBeTruthy();
        expect(report.tasks.status).toBe('ok');
        expect(report.cluster.status).toBe('ok');
        expect(report.settings.status).toBe('ok');
        // The raw error text never reaches the report.
        expect(JSON.stringify(report)).not.toContain('db.internal');
    });

    it('lists pending migrations above the base watermark only', async () => {
        const report = await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(report.instance.migrations?.pending).toEqual([
            { version: '16.413.0', name: 'pending_one' },
        ]);
        expect(report.instance.migrations?.appliedCount).toBe(1);
    });

    it('reads the cluster restarts and sidecars and names the node by role and id prefix', async () => {
        const report = await buildDebugReport(sql, { options: NO_INCLUDE });
        const node = report.cluster.nodes?.[0];
        // role + "-" + the first 8 characters of the instance id.
        expect(node?.name).toBe('web-web-abcd');
        expect(node?.restarts24h).toBe(2);
        expect(node?.uncleanExits24h).toBe(1);
        expect(node?.href).toContain('/cluster/nodes/web-abcdef12-3456');
        expect(report.cluster.sidecars).toEqual([{ name: 'sonic', reachable: 'yes' }]);
    });

    it('groups failed runs by task with at most three sample runs', async () => {
        const report = await buildDebugReport(sql, { options: NO_INCLUDE });
        const group = report.tasks.failedRuns?.[0];
        expect(group?.taskId).toBe('sonic-embedding-backfill');
        expect(group?.count).toBe(2);
        expect(group?.sampleRuns[0]?.runId).toBe(RUN_ID);
        expect(group?.sampleRuns[0]?.href).toBe(`/api/v1/admin/debug-report/runs/${RUN_ID}`);
        expect(group?.firstErrorLine).not.toContain(SECRET);
    });

    it('counts library health issues and integrity violations, unknown type as "unknown"', async () => {
        const report = await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(report.library.mediaHealthIssues).toEqual([
            { type: 'missing_file', count: 4 },
            { type: 'unknown', count: 1 },
        ]);
        expect(report.library.integrityViolations).toEqual([{ rule: 'orphan_file', count: 3 }]);
        expect(report.tasks.pluginFailures).toEqual([{ pluginId: 'fribb-anime-sync', count: 2 }]);
    });

    it('reports the server error signature section as unavailable', async () => {
        const report = await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(report.serverErrors.status).toBe('unavailable');
    });

    it('shows a config value only for a boolean, number or closed choice, never a secret', async () => {
        const report = await buildDebugReport(sql, { options: NO_INCLUDE });
        const tmdb = report.settings.entries?.find((e) => e.key === 'TMDB_API_KEY');
        expect(tmdb?.source).toBe('env');
        expect(tmdb?.set).toBe(true);
        expect(tmdb?.value).toBeUndefined();
        const locale = report.settings.entries?.find((e) => e.key === 'DATE_LOCALE');
        expect(locale?.source).toBe('settings');
        expect(locale?.value).toBe('en-US');
    });

    it('reports integrations as configured and reachable, never URLs', async () => {
        const report = await buildDebugReport(sql, { options: NO_INCLUDE });
        const jellyfin = report.integrations.items?.find((i) => i.name === 'Jellyfin');
        expect(jellyfin).toEqual({ name: 'Jellyfin', configured: true, reachable: 'yes' });
        const trakt = report.integrations.items?.find((i) => i.name === 'Trakt');
        expect(trakt?.configured).toBe(false);
        expect(trakt?.reachable).toBe('not_checked');
        expect(JSON.stringify(report.integrations)).not.toContain('jf.internal');
    });
});

describe('drill-downs', () => {
    it('a run carries its redacted error without a stack and log lines without extra metadata', async () => {
        const detail = await buildRunDetail(sql, RUN_ID);
        const json = JSON.stringify(detail);
        expect(detail?.run.error?.message).toBeTruthy();
        expect(json).not.toContain('at /mnt');
        expect(json).not.toContain('DROP ME');
        expect(json).not.toContain('idempotencyKey');
        expect(json).not.toContain('key-secret');
        expect(json).not.toContain(SECRET);
        expect(detail?.pasteSafe).toBe(false);
    });

    it('returns null for an unknown run, a malformed run id or an unknown fingerprint', async () => {
        mocks.getRun.mockResolvedValueOnce(null);
        expect(await buildRunDetail(sql, RUN_ID)).toBeNull();
        expect(await buildRunDetail(sql, 'not-a-uuid')).toBeNull();
        mocks.listClientDiagnosticGroup.mockResolvedValueOnce([]);
        expect(await buildClientDiagnosticGroup(sql, FINGERPRINT)).toBeNull();
        expect(await buildClientDiagnosticGroup(sql, 'bad fingerprint')).toBeNull();
    });

    it('a cluster node drill-down has no host name and its events carry no host', async () => {
        const detail = await buildClusterNodeDetail(sql, 'web-abcdef12-3456');
        expect(detail?.live).toBe(true);
        expect(JSON.stringify(detail)).not.toContain('worker-7');
        expect(detail?.events[0]).toEqual({
            at: '2026-10-21T09:00:00.000Z',
            eventType: 'online',
            role: 'web',
            version: '0.1.0',
        });
    });

    it('a node that is neither live nor has events is not found', async () => {
        mocks.readClusterNodes.mockResolvedValueOnce([]);
        mocks.getNodeTimeline.mockResolvedValueOnce([]);
        expect(await buildClusterNodeDetail(sql, 'gone-node-1234')).toBeNull();
    });

    it('the health drill-down is the health section of the report', async () => {
        const health = await buildHealthDetail(sql);
        expect(health.status).toBe('ok');
        expect(JSON.stringify(health)).not.toContain('db.internal');
        expect(health.components?.find((c) => c.name === 'database')?.reason).toBe(
            'ECONNREFUSED <host>',
        );
    });
});

describe('review regressions: config availability and enum safety', () => {
    it.each([
        { name: 'report', build: () => buildDebugReport(sql, { options: NO_INCLUDE }) },
        { name: 'run', build: () => buildRunDetail(sql, RUN_ID) },
        { name: 'client group', build: () => buildClientDiagnosticGroup(sql, FINGERPRINT) },
        { name: 'node', build: () => buildClusterNodeDetail(sql, 'web-abcdef12-3456') },
        { name: 'health', build: () => buildHealthDetail(sql) },
    ])('fails closed when config is unreadable for $name', async ({ build }) => {
        mocks.getAll.mockImplementation(() => {
            throw new Error('private config read failure');
        });
        await expect(build()).rejects.toBeInstanceOf(DebugReportConfigurationError);
    });

    it('builds and schema-validates a Kubernetes report with a common-word secret-named env var', async () => {
        vi.stubEnv('SECRETS_BACKEND', 'kubernetes');
        vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.0.0.1');
        const report = DebugReportSchema.parse(
            await buildDebugReport(sql, { options: NO_INCLUDE }),
        );
        expect(report.instance.installType).toBe('kubernetes');
    });

    it('reads the config exactly once for settings and the sweep list', async () => {
        await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(mocks.getAll).toHaveBeenCalledTimes(1);
    });
});

describe('review regressions: drill-down assertion and run states', () => {
    it('sweeps otherwise structural strings in every drill-down and reports the hits', async () => {
        const secret = '2026-10-21';
        mocks.getAll.mockReturnValue({ TMDB_API_KEY: secret });
        const details = [
            await buildRunDetail(sql, RUN_ID),
            await buildClientDiagnosticGroup(sql, FINGERPRINT),
            await buildClusterNodeDetail(sql, 'web-abcdef12-3456'),
            await buildHealthDetail(sql),
        ];
        for (const detail of details) {
            expect(detail).not.toBeNull();
            expect(JSON.stringify(detail)).not.toContain(secret);
            expect(detail?.redaction?.secretSweepHits).toBeGreaterThan(0);
            expect(detail?.redaction?.counts.sweep).toBeGreaterThanOrEqual(
                detail?.redaction?.secretSweepHits ?? 0,
            );
        }
    });

    it.each(['pending', 'active', 'cancelling', 'completed', 'timed_out', 'unknown'])(
        'does not disclose a %s run',
        async (state) => {
            mocks.getRun.mockResolvedValue({ id: RUN_ID, taskId: 'task', state });
            expect(await buildRunDetail(sql, RUN_ID)).toBeNull();
            expect(mocks.readRecent).not.toHaveBeenCalled();
        },
    );

    it.each(['failed', 'cancelled'])('serves a terminal %s run', async (state) => {
        mocks.getRun.mockResolvedValue({ id: RUN_ID, taskId: 'task', state });
        expect((await buildRunDetail(sql, RUN_ID))?.run.state).toBe(state);
    });
});

/** Every non-enum string source read by the builder gets its own credential-shaped marker. */
function seedEveryStringSource(): { markers: string[]; instanceId: string } {
    const markers: string[] = [];
    const marker = (label: string): string => {
        const value = `svc_${label}_marker9981`;
        markers.push(value);
        return value;
    };
    const at = new Date('2026-10-21T10:00:00.000Z');
    Object.assign(mocks.buildInfo, {
        version: marker('buildVersion'),
        commit: marker('commit'),
        commitShort: marker('shortCommit'),
        buildTime: marker('buildTime'),
        branch: marker('branch'),
    });
    mocks.migrations[1]!.name = marker('migrationName');
    mocks.migrations[1]!.version = `16.413.0 ${marker('migrationVersion')}`;
    mocks.currentVersion.mockResolvedValue(marker('currentMigration'));
    mocks.getRuntimeEnvironment.mockReturnValue({
        nodeVersion: marker('nodeVersion'),
        platform: marker('runtimePlatform'),
        arch: marker('arch'),
        containerized: false,
    });
    mocks.getDatabaseVersions.mockResolvedValue({
        postgresVersion: marker('postgresVersion'),
        pgvectorVersion: marker('pgvectorVersion'),
    });
    mocks.getEnabledLibraryPaths.mockResolvedValue([{ path: `/root/${marker('libraryRoot')}` }]);
    mocks.getReadinessChecks.mockResolvedValue({
        orchestrator: true,
        database: true,
        valkey: true,
        cache: 'ok',
        worker: marker('readyWorker'),
        leader: false,
    });
    mocks.buildComponentHealth.mockResolvedValue({
        [marker('componentName')]: { status: 'fail', reason: marker('componentReason') },
        [marker('componentErrorName')]: { status: 'fail', error: marker('componentError') },
    });
    mocks.listFindings.mockResolvedValue([
        {
            invariant_id: marker('invariantId'),
            status: 'red',
            label: marker('findingLabel'),
            value: marker('findingValue'),
            error: marker('findingError'),
            last_change_at: at,
        },
    ]);
    const instanceId = marker('clusterInstance');
    mocks.readClusterNodes.mockResolvedValue([
        {
            instanceId,
            role: marker('nodeRole'),
            version: marker('clusterVersion'),
            implementation: marker('implementation'),
            uptimeSeconds: 1,
            hostname: 'worker-7.cluster.local',
            host: { name: 'worker-7.cluster.local' },
        },
    ]);
    mocks.probeClusterSidecars.mockResolvedValue([
        { kind: marker('sidecarKind'), state: 'healthy' },
    ]);
    const taskId = marker('taskId');
    mocks.listRunFailureRows.mockResolvedValue([
        {
            taskId,
            message: marker('firstError'),
            kind: marker('failureKind'),
            completedAt: at,
        },
    ]);
    mocks.listSampleFailedRuns.mockResolvedValue([
        {
            runId: marker('sampleRunId'),
            taskId,
            completedAt: at,
        },
    ]);
    mocks.getLatestScannerRunPerLibrary.mockResolvedValue([
        {
            library_path_id: marker('libraryPathId'),
            library_path: '/mnt/media/Film (1999)/a.mkv',
            started_at: at,
            completed_at: at,
            total_files: 1,
            matched: 1,
            updated: 0,
            unmatched: 0,
            errors: 0,
        },
    ]);
    mocks.countUnresolvedFailuresByPlugin.mockResolvedValue([
        { pluginId: marker('pluginId'), count: 1 },
    ]);
    mocks.countOpenViolationsByRule.mockResolvedValue({ [marker('rule')]: 1 });
    mocks.countMediaHealthIssuesByType.mockResolvedValue([{ type: marker('issueType'), count: 1 }]);
    mocks.summarizeClientDiagnostics.mockResolvedValue([
        {
            fingerprint: marker('fingerprint'),
            kind: marker('kind'),
            platform: marker('platform'),
            appVersion: marker('appVersion'),
            count: 1,
            firstSeen: at,
            lastSeen: at,
        },
    ]);
    mocks.listClientDiagnosticGroup.mockResolvedValue([
        {
            occurredAt: at,
            kind: marker('clientKind'),
            platform: marker('clientPlatform'),
            appVersion: marker('clientAppVersion'),
            osVersion: marker('osVersion'),
            summary: marker('clientSummary'),
        },
    ]);
    mocks.connectionStatuses.mockReturnValue([
        { name: marker('integrationName'), configured: false },
    ]);
    mocks.getRun.mockResolvedValue({
        id: marker('runId'),
        state: 'failed',
        taskId: marker('runTaskId'),
        createdAt: at,
        startedAt: at,
        completedAt: at,
        error: { message: marker('runMessage'), kind: marker('runErrorKind') },
    });
    mocks.readRecent.mockResolvedValue([
        {
            ts: at.getTime(),
            level: 'error',
            message: marker('logMessage'),
            meta: { ignored: marker('logMeta') },
        },
    ]);
    mocks.getNodeTimeline.mockResolvedValue([
        {
            instanceId,
            eventType: marker('eventType'),
            role: marker('eventRole'),
            version: marker('eventVersion'),
            reason: marker('eventReason'),
            hostname: marker('eventHostname'),
            createdAt: at,
        },
    ]);
    return { markers, instanceId };
}

describe('verification coverage: all builder sources and encoded secrets', () => {
    it.each([NO_INCLUDE, WITH_HOSTS, WITH_PATHS, { includeHostnames: true, includePaths: true }])(
        'does not leak any string-source marker with options %j',
        async (options) => {
            const { markers, instanceId } = seedEveryStringSource();
            const report = DebugReportSchema.parse(await buildDebugReport(sql, { options }));
            const json = JSON.stringify(report);
            const markdown = formatDebugReport(report);
            const run = await buildRunDetail(sql, RUN_ID);
            const group = await buildClientDiagnosticGroup(sql, FINGERPRINT);
            const node = await buildClusterNodeDetail(sql, instanceId);
            const health = await buildHealthDetail(sql);
            expect(run?.run.error?.message).toBeTruthy();
            expect(group?.items).toHaveLength(1);
            expect(node?.live).toBe(true);
            expect(node?.events).toHaveLength(1);
            expect(health.status).toBe('ok');
            const details = JSON.stringify([run, group, node, health]);
            for (const value of markers) {
                expect(json, `JSON leaks ${value}`).not.toContain(value);
                expect(markdown, `Markdown leaks ${value}`).not.toContain(value);
                expect(details, `Drill-down leaks ${value}`).not.toContain(value);
            }
            expect(json.includes('worker-7.cluster.local')).toBe(options.includeHostnames);
            expect(json.includes('/mnt/media/Film (1999)/a.mkv')).toBe(options.includePaths);
            expect(details).not.toContain('worker-7.cluster.local');
            expect(details).not.toContain('/mnt/media');
            expect(report.health.status).toBe('ok');
            expect(report.cluster.status).toBe('ok');
            expect(report.tasks.status).toBe('ok');
            expect(report.tasks.failedRuns).toHaveLength(1);
            expect(report.cluster.nodes).toHaveLength(1);
            expect(report.clientDiagnostics.groups).toHaveLength(1);
            expect(report.integrations.status).toBe('ok');
        },
    );

    it('sweeps every real schema sensitive key from both JSON and Markdown, even when echoed in errors', async () => {
        const sensitive = configSchema.filter((def) => def.uiHints?.sensitive);
        expect(sensitive.length).toBeGreaterThan(0);
        const markers = sensitive.map((_, i) => `secret phrase ${i} marker`);
        mocks.getAll.mockReturnValue(
            Object.fromEntries(sensitive.map((def, i) => [def.key, markers[i]])),
        );
        mocks.listRunFailureRows.mockResolvedValue(
            markers.map((message) => ({
                taskId: 'task',
                message,
                completedAt: new Date('2026-10-21T10:00:00Z'),
            })),
        );
        mocks.listFindings.mockResolvedValue(
            markers.map((value) => ({
                invariant_id: 'finding',
                status: 'red',
                label: 'check',
                value,
                error: value,
                last_change_at: new Date('2026-10-21T10:00:00Z'),
            })),
        );
        const report = await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(report.health.findings).toHaveLength(sensitive.length);
        expect(report.settings.status).toBe('ok');
        for (const marker of markers) {
            expect(JSON.stringify(report)).not.toContain(marker);
            expect(formatDebugReport(report)).not.toContain(marker);
        }
    });

    it('sweeps URL-encoded and base64 spellings in a run message and client summary', async () => {
        const secret = 'p/s+W9';
        const spellings = [encodeURIComponent(secret), Buffer.from(secret).toString('base64')];
        const text = spellings.join(' ');
        mocks.getAll.mockReturnValue({ TMDB_API_KEY: secret });
        mocks.getRun.mockResolvedValue({
            id: RUN_ID,
            taskId: 'task',
            state: 'failed',
            error: { message: text },
        });
        mocks.listRunFailureRows.mockResolvedValue([
            { taskId: 'task', message: text, completedAt: new Date('2026-10-21T10:00:00Z') },
        ]);
        mocks.listClientDiagnosticGroup.mockResolvedValue([
            { occurredAt: new Date(), kind: 'playback_incident', platform: 'tvos', summary: text },
        ]);
        const report = await buildDebugReport(sql, { options: NO_INCLUDE });
        const outputs = [
            JSON.stringify(report),
            formatDebugReport(report),
            JSON.stringify(await buildRunDetail(sql, RUN_ID)),
            JSON.stringify(await buildClientDiagnosticGroup(sql, FINGERPRINT)),
        ];
        for (const output of outputs)
            for (const spelling of spellings) expect(output).not.toContain(spelling);
    });
});

describe('provider probes: process single-flight and five-minute fallback cache', () => {
    it('shares concurrent probes and keeps a result for five minutes while Valkey is down', async () => {
        mocks.cacheGet.mockRejectedValue(new Error('Valkey down'));
        mocks.cacheSet.mockRejectedValue(new Error('Valkey down'));
        let complete: (value: { healthy: boolean }) => void = () => {
            throw new Error('probe not started');
        };
        let started: () => void = () => {
            throw new Error('start waiter not installed');
        };
        const start = new Promise<void>((resolve) => {
            started = resolve;
        });
        const outcome = new Promise<{ healthy: boolean }>((resolve) => {
            complete = resolve;
        });
        mocks.runProviderHealthCheck.mockImplementation(() => {
            started();
            return outcome;
        });
        const builds = Promise.all(
            Array.from({ length: 5 }, () => buildDebugReport(sql, { options: NO_INCLUDE })),
        );
        await start;
        expect(mocks.runProviderHealthCheck).toHaveBeenCalledTimes(1);
        expect(mocks.runProviderHealthCheck).toHaveBeenCalledWith(
            'tmdb',
            undefined,
            expect.any(AbortSignal),
        );
        complete({ healthy: true });
        await builds;
        await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(mocks.runProviderHealthCheck).toHaveBeenCalledTimes(1);
        vi.mocked(Date.now).mockReturnValue(testTime + 299_999);
        await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(mocks.runProviderHealthCheck).toHaveBeenCalledTimes(1);
        vi.mocked(Date.now).mockReturnValue(testTime + 300_000);
        mocks.runProviderHealthCheck.mockResolvedValue({ healthy: false });
        const expired = await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(mocks.runProviderHealthCheck).toHaveBeenCalledTimes(2);
        expect(expired.integrations.items?.find((entry) => entry.name === 'TMDB')?.reachable).toBe(
            'no',
        );
    });

    it('caches failed probes too and probes different providers independently', async () => {
        mocks.getAll.mockReturnValue({
            TMDB_API_KEY: SECRET,
            MDBLIST_API_KEY: 'another-secret-997',
        });
        mocks.cacheGet.mockRejectedValue(new Error('Valkey down'));
        mocks.runProviderHealthCheck.mockRejectedValue(new Error('provider down'));
        await buildDebugReport(sql, { options: NO_INCLUDE });
        await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(
            mocks.runProviderHealthCheck.mock.calls.map(([provider]) => provider).sort(),
        ).toEqual(['mdblist', 'tmdb']);
    });

    it('uses a Valkey cached result without probing and retains it locally', async () => {
        mocks.cacheGet.mockResolvedValue(JSON.stringify({ reachable: true }));
        await buildDebugReport(sql, { options: NO_INCLUDE });
        mocks.cacheGet.mockRejectedValue(new Error('Valkey down'));
        await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(mocks.runProviderHealthCheck).not.toHaveBeenCalled();
    });
});

describe('provider timeout fallback', () => {
    it('finishes within five seconds and caches the failure when a provider ignores cancellation', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(testTime));
        let started: () => void = () => {
            throw new Error('waiter not installed');
        };
        const start = new Promise<void>((resolve) => {
            started = resolve;
        });
        mocks.runProviderHealthCheck.mockImplementation(() => {
            started();
            return new Promise<never>(() => {
                /* This provider deliberately ignores cancellation. */
            });
        });
        const building = buildDebugReport(sql, { options: NO_INCLUDE });
        await start;
        await vi.advanceTimersByTimeAsync(5000);
        const report = await building;
        expect(report.integrations.items?.find((entry) => entry.name === 'TMDB')?.reachable).toBe(
            'no',
        );
        await buildDebugReport(sql, { options: NO_INCLUDE });
        expect(mocks.runProviderHealthCheck).toHaveBeenCalledTimes(1);
    });
});
