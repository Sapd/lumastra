// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — external plugin module-eval throw (Test 7).
 *
 * A plugin whose first line is `throw new Error('init bomb')` must not
 * crash the loader process. loadExternalPlugin must return false, log the
 * error, and allow the caller to increment its errorCount.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../database/queries/metadata-aggregation.queries.js', () => ({
    setEffectiveFieldPriorities: vi.fn(),
}));
vi.mock('$lib/server/tasks/registry.js', () => ({
    ID_PATTERN: /^[a-z][a-z0-9-]*$/,
    registry: {
        registerTask: vi.fn(),
        registerProvider: vi.fn(),
        registerTrickplay: vi.fn(),
        registerWatchSync: vi.fn(),
        registerFeature: vi.fn(),
        registerIntegration: vi.fn(),
        registerMediaSource: vi.fn(),
        registerExternalService: vi.fn(),
        getAllProviders: vi.fn(() => []),
        getAllFeatures: vi.fn(() => []),
        getAllIntegrations: vi.fn(() => []),
        getAllTrickplays: vi.fn(() => []),
        getAllMediaSources: vi.fn(() => []),
        getAllWatchSyncs: vi.fn(() => []),
        getAllExternalServices: vi.fn(() => []),
        getAllTasks: vi.fn(() => []),
    },
}));
vi.mock('../../providers/normalize.js', () => ({
    registerProviderNormalizer: vi.fn(),
    unregisterProviderNormalizer: vi.fn(),
}));
vi.mock('../../providers/encode-id.js', () => ({
    registerProviderEncoder: vi.fn(),
    unregisterProviderEncoder: vi.fn(),
}));

// `vi.mock()` calls are hoisted to the top of the file, BEFORE module-level
// `const` declarations. Use `vi.hoisted()` so the mock factory captures a
// reference defined in the same hoisted phase, otherwise `mockError` is
// undefined when the mock factory runs at import time.
const { mockError } = vi.hoisted(() => ({ mockError: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: mockError,
        }),
    },
}));

import { loadExternalPlugin } from './loader.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lumastra-plugin-eval-test-'));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('loadExternalPlugin — module eval throw', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        mockError.mockClear();
        for (const dir of tempDirs) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // best-effort cleanup
            }
        }
        tempDirs.length = 0;
    });

    it('returns false when the module top-level throws (init bomb)', async () => {
        const dir = makeTempDir();
        tempDirs.push(dir);

        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'bomb-plugin', main: 'index.js' }),
        );
        // CJS throw — module evaluation fails immediately.
        fs.writeFileSync(
            path.join(dir, 'index.js'),
            `throw new Error('init bomb');\nmodule.exports = {};\n`,
        );

        const result = await loadExternalPlugin(dir);
        expect(result).toBe(false);
    });

    it('logs an error with path context when the module throws', async () => {
        const dir = makeTempDir();
        tempDirs.push(dir);

        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'bomb-plugin2', main: 'index.js' }),
        );
        fs.writeFileSync(
            path.join(dir, 'index.js'),
            `throw new Error('init bomb');\nmodule.exports = {};\n`,
        );

        await loadExternalPlugin(dir);

        // logger.error must have been called at least once.
        expect(mockError).toHaveBeenCalled();
        // The logged context should include the plugin path so operators can diagnose.
        const allArgs = mockError.mock.calls.flat();
        const mentionsPath = allArgs.some(
            (a) =>
                (typeof a === 'string' && a.includes(dir)) ||
                (a !== null && typeof a === 'object' && JSON.stringify(a).includes(dir)),
        );
        expect(mentionsPath).toBe(true);
    });

    it('process does NOT exit after an eval throw — subsequent plugins are still loadable', async () => {
        const bombDir = makeTempDir();
        const goodDir = makeTempDir();
        tempDirs.push(bombDir, goodDir);

        // Bomb plugin.
        fs.writeFileSync(
            path.join(bombDir, 'package.json'),
            JSON.stringify({ name: 'bomb-plugin3', main: 'index.js' }),
        );
        fs.writeFileSync(path.join(bombDir, 'index.js'), `throw new Error('init bomb');\n`);

        // Good plugin — has a `search` method → detected as provider shape.
        fs.writeFileSync(
            path.join(goodDir, 'package.json'),
            JSON.stringify({ name: 'good-provider', main: 'index.js' }),
        );
        fs.writeFileSync(
            path.join(goodDir, 'index.js'),
            [
                'module.exports = {',
                '  id: "good-provider",',
                '  name: "Good",',
                '  version: "1.0.0",',
                '  capabilities: {},',
                '  isConfigured: async () => true,',
                '  search: async () => [],',
                '  detail: async () => ({})',
                '};',
            ].join('\n'),
        );

        const bombResult = await loadExternalPlugin(bombDir);
        const goodResult = await loadExternalPlugin(goodDir);

        // The bomb must fail cleanly.
        expect(bombResult).toBe(false);
        // The subsequent load is attempted and returns true (shape detected).
        expect(goodResult).toBe(true);
    });
});
