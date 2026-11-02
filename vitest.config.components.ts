import { defineConfig } from 'vitest/config';
import { cleanVitestTmpDir } from './vitest.tmpdir-cleanup';
import { diagnosticRouteWords } from './vite.diagnostic-route-words';
import { paraglideLocaleModulesForTests } from './vitest.paraglide-locale-modules';
import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';

/**
 * Vitest config for Svelte component tests.
 *
 * Uses happy-dom + svelteTesting() plugin so that Svelte resolves to client-side
 * exports (browser conditions). This is separated from the main vitest.config.ts
 * because the browser resolve conditions break node-environment tests that
 * transitively import SvelteKit client modules.
 *
 * Run: npx vitest run --config vitest.config.components.ts
 */
export default defineConfig({
    define: {
        __API_CONTRACT_STRICT__: true,
        __DIAGNOSTIC_ROUTE_WORDS__: JSON.stringify(diagnosticRouteWords(process.cwd())),
    },
    plugins: [sveltekit(), svelteTesting(), cleanVitestTmpDir(), paraglideLocaleModulesForTests()],
    test: {
        include: [
            'src/lib/components/**/*.{test,spec}.{js,ts}',
            // Top-level components (Sidebar, Search, Footer, ...) live in
            // src/lib/ rather than src/lib/components/, so their component
            // tests were not discovered by the glob above.
            'src/lib/*.svelte.test.ts',
            'src/routes/**/*.svelte.test.ts',
        ],
        exclude: ['**/*.integration.test.ts', 'node_modules/**'],
        environment: 'happy-dom',
        globals: true,
        setupFiles: ['./src/test-setup/components.setup.ts'],
        pool: 'forks',
        // Vitest 4 spelling. A `forks: { maxForks }` key here is not a valid
        // option — it was silently ignored (no deprecation warning, unlike the
        // nested `poolOptions` form), so this cap never applied. See vitest.config.ts.
        maxWorkers: 4,
        minWorkers: 1,
        fileParallelism: true,
        isolate: true,
        testTimeout: 10000,
        hookTimeout: 10000,
    },
});
