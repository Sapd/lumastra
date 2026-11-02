// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — plugin export matches no contract shape (Test 4).
 *
 * A plugin whose default export has no known SDK contract methods must be
 * rejected cleanly: detectSdkDefinition returns null, the loader logs an
 * error mentioning the valid contract names, and the load is counted as an
 * error without crashing the process.
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
    // ID_PATTERN is consumed at module-eval time by the manifest schema
    // (external-install/manifest.ts), which the loader now imports transitively
    // via bundle-artifact.ts. Keep it in sync with the real registry export.
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

// Use `vi.hoisted()` so the reference exists when the hoisted `vi.mock()`
// factory runs at import time.
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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lumastra-plugin-shape-test-'));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('loadExternalPlugin — unknown export shape', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        mockError.mockClear();
        for (const dir of tempDirs) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // best-effort
            }
        }
        tempDirs.length = 0;
    });

    it('returns false when the default export has no SDK contract methods', async () => {
        const dir = makeTempDir();
        tempDirs.push(dir);

        // No execute, search, detail, scan, routes, handleWebhook, etc.
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'bad-shape-plugin', main: 'index.js' }),
        );
        fs.writeFileSync(
            path.join(dir, 'index.js'),
            // CommonJS default export to avoid ESM import-assertion issues in the test runner.
            `module.exports = { version: '1.0', doSomething: function() {} };\n`,
        );

        const result = await loadExternalPlugin(dir);
        expect(result).toBe(false);
    });

    /**
     * A contract method the detector does not know about is worse than an
     * unknown export: the plugin has no `handleWebhook`/`sendNotification`, so
     * it is not seen as an integration, falls through to the external-service
     * branch — which by design accepts anything with an id and no contract
     * method — and registers CLEANLY as the wrong kind. The operator sees a
     * green plugin whose entire policy never runs.
     */
    it.each([
        ['authorizePlayback', 'integration'],
        ['homeSections', 'feature'],
        ['decorateCards', 'feature'],
        ['beginLogin', 'auth provider'],
    ])(
        'refuses a %s-only export rather than absorbing it as an external service',
        async (method) => {
            const dir = makeTempDir();
            tempDirs.push(dir);
            const name = `only-${method.toLowerCase()}`;
            fs.writeFileSync(
                path.join(dir, 'package.json'),
                JSON.stringify({ name, main: 'index.js' }),
            );
            fs.writeFileSync(
                path.join(dir, 'index.js'),
                `module.exports = { id: '${name}', settings: { fields: [] }, ${method}: function() {} };\n`,
            );

            const result = await loadExternalPlugin(dir);
            expect(result).toBe(false);
        },
    );

    it('logs an error mentioning at least one valid contract name on shape mismatch', async () => {
        const dir = makeTempDir();
        tempDirs.push(dir);

        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'bad-shape-plugin2', main: 'index.js' }),
        );
        fs.writeFileSync(
            path.join(dir, 'index.js'),
            `module.exports = { version: '1.0', doSomething: function() {} };\n`,
        );

        await loadExternalPlugin(dir);

        expect(mockError).toHaveBeenCalled();
        // The error message must reference at least one of the valid SDK contracts.
        const allLogText = mockError.mock.calls
            .map((args) =>
                args.map((a) => (a instanceof Error ? a.message : JSON.stringify(a))).join(' '),
            )
            .join('\n');

        const contractNames = [
            'defineTask',
            'defineProvider',
            'defineTrickplayProvider',
            'defineWatchSync',
            'defineFeature',
            'defineIntegration',
            'defineMediaSource',
            'defineExternalService',
        ];
        const mentionsAContract = contractNames.some((name) => allLogText.includes(name));
        expect(mentionsAContract).toBe(true);
    });

    it('does not register anything when the shape is unrecognised', async () => {
        const { registry } = await import('$lib/server/tasks/registry.js');
        vi.clearAllMocks();

        const dir = makeTempDir();
        tempDirs.push(dir);

        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'bad-shape-plugin3', main: 'index.js' }),
        );
        fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { random: 42 };\n`);

        await loadExternalPlugin(dir);

        // None of the registry registration methods should have been called.
        expect(registry.registerTask).not.toHaveBeenCalled();
        expect(registry.registerProvider).not.toHaveBeenCalled();
        expect(registry.registerFeature).not.toHaveBeenCalled();
    });
});

describe('the shape-rejection message', () => {
    const tempDirs: string[] = [];
    afterEach(() => {
        mockError.mockClear();
        for (const dir of tempDirs) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // best-effort
            }
        }
        tempDirs.length = 0;
    });

    it('names every contract the loader can actually validate', async () => {
        const dir = makeTempDir();
        tempDirs.push(dir);
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'nothing-plugin', main: 'index.js' }),
        );
        fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { nope: 1 };\n`);

        await loadExternalPlugin(dir);
        const message = mockError.mock.calls.flat().map(String).join(' ');
        // Derived from SDK_VALIDATORS, so this cannot fall behind again — the
        // hand-written list had already lost lyrics and auth providers, telling
        // an author those contracts did not exist.
        for (const name of [
            'defineTask',
            'defineProvider',
            'defineTrickplayProvider',
            'defineWatchSync',
            'defineFeature',
            'defineIntegration',
            'defineMediaSource',
            'defineExternalService',
            'defineSubtitleProvider',
            'defineLyricsProvider',
            'defineAuthProvider',
        ]) {
            expect(message).toContain(name);
        }
    });
});
