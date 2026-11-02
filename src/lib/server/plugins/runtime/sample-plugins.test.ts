// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sample plugins in `examples/plugins/` must actually load.
 *
 * These are the drop-in examples an author copies, and every prior check on
 * the drop-in path tested the LISTING — which directories the host would show —
 * never that a real plugin directory survives detection, validation and
 * registration. That gap is why `defineTask` accepting what the registry
 * rejected went unnoticed, and why nobody spotted that a widgets-only feature
 * is refused.
 *
 * Loading each sample through the real `loadExternalPlugin` closes it: if the
 * host's rules and the documented examples ever drift apart, this fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const registered: Array<{ kind: string; id: string }> = [];

vi.mock('../../database/queries/metadata-aggregation.queries.js', () => ({
    setEffectiveFieldPriorities: vi.fn(),
}));
vi.mock('$lib/server/tasks/registry.js', () => ({
    ID_PATTERN: /^[a-z][a-z0-9-]*$/,
    registry: {
        registerTask: vi.fn((d: { id: string }) => registered.push({ kind: 'task', id: d.id })),
        registerFeature: vi.fn((d: { id: string }) =>
            registered.push({ kind: 'feature', id: d.id }),
        ),
        registerIntegration: vi.fn((d: { id: string }) =>
            registered.push({ kind: 'integration', id: d.id }),
        ),
        registerExternalService: vi.fn((d: { id: string }) =>
            registered.push({ kind: 'external-service', id: d.id }),
        ),
        registerSubtitleProvider: vi.fn((d: { id: string }) =>
            registered.push({ kind: 'subtitle-provider', id: d.id }),
        ),
        registerLyricsProvider: vi.fn((d: { id: string }) =>
            registered.push({ kind: 'lyrics-provider', id: d.id }),
        ),
        // The aggregate path consults this for the ANCHOR rule.
        hasPluginRegistered: (id: string) => registered.some((r) => r.id === id),
        registerProvider: vi.fn(),
        registerTrickplay: vi.fn(),
        registerWatchSync: vi.fn(),
        registerMediaSource: vi.fn(),
        registerAuthProvider: vi.fn(),
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
const { mockError } = vi.hoisted(() => ({ mockError: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: mockError }),
    },
}));

import { loadExternalPlugin } from './loader.js';
import { pluginIdForTask } from './task-origin.js';

const EXAMPLES = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../examples/plugins',
);

beforeEach(() => {
    registered.length = 0;
    mockError.mockClear();
});

describe('the examples directory', () => {
    it('exists and is not empty — the docs point authors at it', () => {
        expect(fs.existsSync(EXAMPLES)).toBe(true);
        expect(fs.readdirSync(EXAMPLES).length).toBeGreaterThan(0);
    });
});

describe.each([
    ['sample-task', 'task'],
    ['sample-feature', 'feature'],
    ['sample-external-service', 'external-service'],
    ['sample-subtitle-provider', 'subtitle-provider'],
    ['sample-integration', 'integration'],
    ['sample-lyrics-ts', 'lyrics-provider'],
])('%s', (dirName, expectedKind) => {
    it(`loads and registers as a ${expectedKind}`, async () => {
        const ok = await loadExternalPlugin(path.join(EXAMPLES, dirName));
        // The error log is the useful failure message when this breaks.
        expect(mockError.mock.calls.map(String).join(' ')).not.toMatch(/does not match any SDK/);
        expect(ok).toBe(true);
        expect(registered).toContainEqual({ kind: expectedKind, id: dirName });
        // The admin catalog labels a plugin's task with where it came from.
        if (expectedKind === 'task') expect(pluginIdForTask(dirName)).toBe(dirName);
    });
});

describe('sample-bundle — several contracts in one plugin', () => {
    it('registers every contract it declares', async () => {
        const ok = await loadExternalPlugin(path.join(EXAMPLES, 'sample-bundle'));
        if (!ok) throw new Error('load failed: ' + mockError.mock.calls.map(String).join(' | '));
        expect(ok).toBe(true);
        // The ANCHOR: one contract named after the plugin itself, which is how
        // the host answers "is this loaded?".
        expect(registered).toContainEqual({ kind: 'feature', id: 'sample-bundle' });
        // And a namespaced sibling.
        expect(registered).toContainEqual({ kind: 'task', id: 'sample-bundle-cleanup' });
    });
});
