import { defineConfig } from 'vitest/config';
import { cleanVitestTmpDir } from './vitest.tmpdir-cleanup';
import { diagnosticRouteWords } from './vite.diagnostic-route-words';
import { paraglideLocaleModulesForTests } from './vitest.paraglide-locale-modules';
import { sveltekit } from '@sveltejs/kit/vite';
import { ISOLATED_UNIT_FILES } from './vitest.isolated-files';

const UNIT_INCLUDE = [
    'src/**/*.{test,spec}.{js,ts}',
    'scripts/**/*.{test,spec}.{js,ts}',
    'plugins/**/*.{test,spec}.{js,ts}',
    // CI parity / lint tests that live outside src/ but run with the main
    // suite. Only `*.test.*` — the `tests/*.spec.ts` files are Playwright
    // E2E specs (run by playwright.config.ts) and must NOT be picked up by
    // vitest (they call @playwright/test's test.describe and error here).
    'tests/*.test.{js,ts}',
];

const BASE_EXCLUDE = [
    '**/*.integration.test.ts',
    'node_modules/**',
    // STILL EXCLUDED, but not for the reason this line used to give.
    //
    // The file's `vi.mock('util')` replaced `promisify` with an IDENTITY
    // function, so `execAsync = promisify(exec)` resolved to the raw exec
    // mock. Production calls `await execAsync(cmd, opts)` and lets
    // promisify supply the callback, so no callback was ever synthesized:
    // the mock returned `{}`, `stdout` was undefined, `JSON.parse` threw,
    // and analyzeSegmentForIFrames swallowed it and returned []. Every
    // ffprobe call, every fixture, from the file's first commit — the
    // suite never exercised its own fixtures and its green tests were
    // green by coincidence.
    //
    // That mock is now a real promisify shim, which is why the fixtures
    // finally reach the parser. The blocker is now genuine: with ffprobe
    // succeeding, `consecutiveFailures` stays 0, so runAnalysis's
    // `while (shouldContinue())` loop no longer bails at
    // MAX_CONSECUTIVE_FAILURES and the harness never completes the job —
    // it spins until the worker dies at a 4 GB heap.
    //
    // Re-enabling needs the harness to terminate the loop (complete the
    // job, or drive shouldContinue explicitly). The analyzer itself is
    // NOT implicated: its retention cap splices correctly and its ffprobe
    // parsing is unchanged. This module has no other coverage.
    'src/lib/server/services/transcoding/iframe-analyzer.test.ts',
    // Component tests use vitest.config.components.ts (needs happy-dom + browser resolve)
    'src/lib/components/**/*.{test,spec}.{js,ts}',
    // Top-level components (Sidebar, Search, Footer) live directly in
    // src/lib/, so `src/lib/components/**` above does not cover their
    // tests. Without this they run HERE, in the node environment with
    // Svelte's server exports, where `mount()` does not exist — green
    // locally under the components config, red in CI.
    'src/lib/*.svelte.test.ts',
    // Route-level component tests also belong to the components config —
    // they call mount(), which the node-environment server runtime lacks.
    'src/routes/**/*.svelte.test.ts',
];

export default defineConfig({
    define: {
        __API_CONTRACT_STRICT__: true,
        __DIAGNOSTIC_ROUTE_WORDS__: JSON.stringify(diagnosticRouteWords(process.cwd())),
    },
    plugins: [sveltekit(), cleanVitestTmpDir(), paraglideLocaleModulesForTests()],
    test: {
        // Unit fixtures mock external I/O but still exercise topology validation.
        // These syntactic defaults exist only in this unit config; integrations
        // use their separate config and must supply explicit real endpoints.
        env: {
            TASK_CACHE_URL: process.env.TASK_CACHE_URL ?? 'redis://task-unit.invalid:6379/1',
            CACHE_URL: process.env.CACHE_URL ?? '',
        },
        environment: 'node',
        globals: true,
        // Memory optimization settings - parallel with controlled worker count.
        //
        // Vitest 4 removed `poolOptions`; its members are top-level and RENAMED
        // (`maxForks` → `maxWorkers`, `minForks` → `minWorkers`). This block was
        // left in the pre-4 nested shape through the upgrade, so the cap below
        // was NOT being applied — vitest fell back to its default worker count
        // (one per CPU) and printed a deprecation notice that scrolled past on
        // every run. On a many-core machine that is what made the full suite
        // flaky under load and pushed heavy files (orchestrator, iframe-analyzer)
        // into OOM. Keep these names in sync with the migration guide, not with
        // the `pool: 'forks'` vocabulary.
        pool: 'forks',
        maxWorkers: 4, // Limit concurrent workers to prevent OOM
        minWorkers: 1,
        // Allow parallel file execution (controlled by maxWorkers)
        fileParallelism: true,
        // Default: every file in its own process. The `unit` project below turns
        // this off for the bulk of the suite; `unit-isolated` keeps it for the
        // files listed in vitest.isolated-files.ts.
        isolate: true,
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    // Shared workers: ~2x faster than one process per file. Module
                    // state and process globals are reset between files by the
                    // setup file, see vitest.shared-setup.ts.
                    isolate: false,
                    include: UNIT_INCLUDE,
                    exclude: [...BASE_EXCLUDE, ...ISOLATED_UNIT_FILES],
                    setupFiles: ['./vitest.shared-setup.ts'],
                },
            },
            {
                extends: true,
                test: {
                    name: 'unit-isolated',
                    isolate: true,
                    // `include`/`exclude` are set per project on purpose: vitest merges
                    // arrays with the root config, so a root-level `include` would be
                    // appended here and this project would run the whole suite again.
                    // An empty list must not fall back to Vitest's default include.
                    exclude: BASE_EXCLUDE,
                    include:
                        ISOLATED_UNIT_FILES.length > 0
                            ? [...ISOLATED_UNIT_FILES]
                            : ['no-isolated-unit-files'],
                },
            },
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'json-summary'],
            include: [
                'src/lib/server/utils/**/*.ts',
                'src/lib/server/services/**/*.ts',
                'src/lib/server/transformers.ts',
                'src/lib/server/middleware/**/*.ts',
                'src/lib/server/database.ts',
            ],
            exclude: ['**/*.test.ts', '**/*.spec.ts', '**/*.d.ts', '**/types.ts', '**/index.ts'],
            // Coverage thresholds - start achievable, increase over time
            thresholds: {
                lines: 30,
                functions: 30,
                branches: 25,
                statements: 30,
            },
        },
        // Timeout for individual tests. 30s (not 10s) because tests that
        // transitively import the task system (loadBuiltins imports ~40 native
        // plugin modules) pay a ~10-12s cold vitest-SSR transform cost on the
        // first import in a worker, which tips a 10s budget over under parallel
        // contention (observed on boot-timing, scheduler, session-kill, etc.).
        testTimeout: 30000,
        // Hook timeout (same cold-import cost applies to beforeEach/beforeAll).
        hookTimeout: 30000,
    },
});
