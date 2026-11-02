import { defineConfig } from 'vitest/config';
import { cleanVitestTmpDir } from './vitest.tmpdir-cleanup';
import { paraglideLocaleModulesForTests } from './vitest.paraglide-locale-modules';
import { sveltekit } from '@sveltejs/kit/vite';

/**
 * Vitest configuration for disk-only integration tests (no database required).
 * Use: npm run test:integration:disk
 *
 * These tests only need the filesystem — no PostgreSQL, no Valkey.
 * E.g. music-transcode disk LRU cache integration tests.
 */
export default defineConfig({
    define: { __API_CONTRACT_STRICT__: true },
    plugins: [sveltekit(), cleanVitestTmpDir(), paraglideLocaleModulesForTests()],
    test: {
        include: ['src/lib/server/services/music-transcode/*.integration.test.ts'],
        exclude: ['node_modules/**'],
        environment: 'node',
        globals: true,
        testTimeout: 30000,
        hookTimeout: 30000,
        pool: 'forks',
        fileParallelism: false,
    },
});
