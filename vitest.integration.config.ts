import 'dotenv/config';
import { defineConfig } from 'vitest/config';
import { cleanVitestTmpDir } from './vitest.tmpdir-cleanup';
import { paraglideLocaleModulesForTests } from './vitest.paraglide-locale-modules';
import { sveltekit } from '@sveltejs/kit/vite';

// Resolve the integration test database URL the same way test-database.ts does:
// explicit TEST_DATABASE_URL wins, otherwise derive it from DATABASE_URL by
// swapping the database name to lumastra_tests (same host/credentials, never
// production). Injected into `test.env` below so it lands in process.env BEFORE
// any module (config.ts, database/connection.ts, services that capture their own
// getDb() handle) loads — otherwise those modules snapshot DATABASE_URL=lumastra_dev
// and services write to the WRONG database, surfacing as fk_pat_user violations
// and cross-DB read/write mismatches. Setup-file mirroring is too late because
// ES import hoisting evaluates connection.ts before the setup body runs.
function resolveTestDatabaseUrl(): string | undefined {
    if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
    if (process.env.DATABASE_URL) {
        try {
            const url = new URL(process.env.DATABASE_URL);
            url.pathname = '/lumastra_tests';
            return url.toString();
        } catch {
            return undefined;
        }
    }
    return undefined;
}
const TEST_DATABASE_URL = resolveTestDatabaseUrl();

// Valkey logical DB reserved for integration runs — a scratch DB kept apart
// from a live app's DB 0. Several task/cache tests FLUSHDB, so a CACHE_URL inherited from .env
// (the dev Valkey, DB 0) must never reach them unchanged.
const INTEGRATION_CACHE_DB = 15;

// Rewrite whatever CACHE_URL the environment provides (host, auth) onto the
// scratch DB. An explicit TEST_CACHE_URL is taken verbatim.
function resolveTestCacheUrl(): string | undefined {
    if (process.env.TEST_CACHE_URL) return process.env.TEST_CACHE_URL;
    if (!process.env.CACHE_URL) return undefined;
    try {
        const url = new URL(process.env.CACHE_URL);
        url.pathname = `/${INTEGRATION_CACHE_DB}`;
        return url.toString();
    } catch {
        return undefined;
    }
}
const TEST_CACHE_URL = resolveTestCacheUrl();
// Dedicated task store uses the same safe scratch-DB rule but must be a
// physically distinct server. Never derive it from the disposable cache URL.
function resolveTestTaskCacheUrl(): string | undefined {
    if (process.env.TEST_TASK_CACHE_URL) return process.env.TEST_TASK_CACHE_URL;
    if (!process.env.TASK_CACHE_URL) return undefined;
    try {
        const url = new URL(process.env.TASK_CACHE_URL);
        url.pathname = `/${INTEGRATION_CACHE_DB}`;
        return url.toString();
    } catch {
        return undefined;
    }
}
const TEST_TASK_CACHE_URL = resolveTestTaskCacheUrl();

/**
 * Vitest configuration for integration tests only.
 * Use: npm run test:integration
 *
 * These tests require:
 * - TEST_DATABASE_URL: PostgreSQL 17+ with pgvector (defaults to DATABASE_URL's server, db lumastra_tests)
 * - DATABASE_URL: Fallback if TEST_DATABASE_URL not set
 * - CACHE_URL / TEST_CACHE_URL: disposable cache Valkey; rewritten onto scratch DB15
 * - TASK_CACHE_URL / TEST_TASK_CACHE_URL: distinct task Valkey; rewritten onto scratch DB15
 * - TMDB_API_KEY: TMDB API access (optional for query tests)
 * - OPENAI_API_KEY: OpenAI embedding generation (optional)
 *
 * Setup test database:
 *   npm run db:test:create    # Creates lumastra_tests database
 *   npm run test:integration  # Runs migrations automatically on first run
 */
export default defineConfig({
    define: { __API_CONTRACT_STRICT__: true },
    plugins: [sveltekit(), cleanVitestTmpDir(), paraglideLocaleModulesForTests()],
    test: {
        // Match both naming conventions: *.integration.test.ts and *-integration.test.ts
        // Also covers tests/integration/ for top-level characterization tests.
        include: [
            'src/**/*.integration.test.ts',
            'src/**/*-integration.test.ts',
            'plugins/**/*.integration.test.ts',
            'tests/integration/**/*.integration.test.ts',
            'tests/integration/**/*-integration.test.ts',
        ],
        exclude: ['node_modules/**'],
        environment: 'node',
        globals: true,
        // Provide a deterministic test master key for PluginSecrets encrypt/
        // decrypt round-trips (e.g. MAL borrower-credential seeding in the
        // coverage-table disposition contract). config.ts captures
        // LUMASTRA_MASTER_KEY at module load, so it must be present in
        // process.env before any setup file imports it. Applied only when the
        // environment has not already configured a real key.
        env: {
            // Task integration tests explicitly host consumers. Web-process
            // fixtures set their own disabled/false role at the process seam.
            WORKER_MODE: 'enabled',
            DEDICATED_WORKER: 'true',
            LUMASTRA_MASTER_KEY:
                process.env.LUMASTRA_MASTER_KEY ??
                '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
            // Exercise MediaLifecycleService's legacy direct stage-invalidation
            // wrappers (afterContentChanged/afterReplaced/afterMatched/
            // afterMetadataChanged). Their default flipped to the event-outbox
            // path (flag true → wrappers no-op); only the media-lifecycle*.integration
            // tests call those wrappers, so forcing the flag off here keeps that
            // shipped-but-gated path covered without affecting any other test.
            // config.ts snapshots this at module load, so it must be set before any
            // setup file imports config (this env block is applied first).
            FEATURE_PIPELINE_EVENT_OUTBOX: process.env.FEATURE_PIPELINE_EVENT_OUTBOX ?? 'false',
            // Point ALL database access (including services that capture their own
            // getDb() handle, not just the integration sql) at lumastra_tests.
            // Must be in test.env so it is set before any module snapshots
            // DATABASE_URL. dotenv (loaded in the setup file) won't override an
            // already-set var, so this value wins. TEST_DATABASE_URL is set too:
            // ~30 files (task runner, cross-replica, reconciler, ...) run only
            // when it is present, and CI always exports it — leaving it unset
            // made a local run silently skip what CI blocks on.
            ...(TEST_DATABASE_URL ? { DATABASE_URL: TEST_DATABASE_URL, TEST_DATABASE_URL } : {}),
            // Scratch Valkey DB (see INTEGRATION_CACHE_DB). Set here, before any
            // module snapshots CACHE_URL, so the FLUSHDB-ing tests can only ever
            // hit DB 15, never the dev/app cache on DB 0.
            ...(TEST_CACHE_URL ? { CACHE_URL: TEST_CACHE_URL, TEST_CACHE_URL } : {}),
            ...(TEST_TASK_CACHE_URL
                ? { TASK_CACHE_URL: TEST_TASK_CACHE_URL, TEST_TASK_CACHE_URL }
                : {}),
        },
        // Migrations run once in globalSetup (its own module graph). The per-file
        // setup must stay free of server imports, or test files' vi.mock calls
        // stop reaching the modules it preloaded (docs/dev/testing-traps.md).
        globalSetup: ['./tests/integration/setup/global-setup.ts'],
        setupFiles: ['./tests/integration/setup/vitest.setup.ts'],
        // Test files load the server graph, and several modules there
        // SUBSCRIBE to Valkey pub/sub at import time and log when it completes.
        // A file whose tests are all skipped (baselines, the live sweeps) skips
        // its hooks, ends at once, and vitest rejects the still-pending console
        // RPC with this error, failing the shard (1612 passed, exit 1). A lost
        // log line from a finished file hides no test result, so drop exactly
        // this one; every other teardown error still fails the run.
        onUnhandledError(error) {
            if (
                error.name === 'EnvironmentTeardownError' &&
                error.message.includes('"onUserConsoleLog" was pending')
            ) {
                return false;
            }
        },
        // Longer timeouts for integration tests (API calls, DB operations)
        testTimeout: 60000,
        hookTimeout: 120000, // Increased for initial migration setup
        // Run integration tests sequentially to avoid resource contention
        // Vitest 4+: poolOptions moved to top level
        pool: 'forks',
        fileParallelism: false,
    },
});
