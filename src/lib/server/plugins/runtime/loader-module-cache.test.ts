// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Re-importing a plugin path after its contents changed.
 *
 * Node caches ES modules by URL for the life of the process, and an install
 * always lands at the same stable path (`<pluginsDir>/<name>/index.js`). So a
 * failed install that got as far as importing leaves a broken module cached
 * under the path a corrected reinstall will use — the digest gate verifies the
 * NEW bytes, and then `import()` hands back the OLD module. The operator sees a
 * valid signed bundle refuse to install with an error that no longer exists in
 * the file, and nothing in the logs explains it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../database/queries/metadata-aggregation.queries.js', () => ({
    setEffectiveFieldPriorities: vi.fn(),
}));
const registered: string[] = [];
vi.mock('$lib/server/tasks/registry.js', () => ({
    ID_PATTERN: /^[a-z][a-z0-9-]*$/,
    registry: {
        registerExternalService: vi.fn((def: { id: string }) => registered.push(def.id)),
        registerTask: vi.fn(),
        registerProvider: vi.fn(),
        registerTrickplay: vi.fn(),
        registerWatchSync: vi.fn(),
        registerFeature: vi.fn(),
        registerIntegration: vi.fn(),
        registerMediaSource: vi.fn(),
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
vi.mock('../../utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}));

import { loadExternalPlugin } from './loader.js';

describe('re-importing a changed plugin file', () => {
    const dirs: string[] = [];

    afterEach(() => {
        registered.length = 0;
        for (const d of dirs) {
            try {
                fs.rmSync(d, { recursive: true, force: true });
            } catch {
                // best-effort
            }
        }
        dirs.length = 0;
    });

    it('picks up the NEW contents rather than a cached module', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumastra-modcache-'));
        dirs.push(dir);
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'cache-probe', main: 'index.js' }),
        );

        // First load: a broken id, so it is rejected — but the module is now in
        // Node's cache under this path.
        fs.writeFileSync(
            path.join(dir, 'index.js'),
            `module.exports = { id: 'Not A Valid Id', settings: { fields: [] } };\n`,
        );
        expect(await loadExternalPlugin(dir)).toBe(false);

        // The author fixes it and the operator reinstalls to the same path.
        // mtime resolution is coarse enough that a same-millisecond rewrite
        // could otherwise collide, so make the change unambiguous.
        await new Promise((r) => setTimeout(r, 15));
        fs.writeFileSync(
            path.join(dir, 'index.js'),
            `module.exports = { id: 'cache-probe', settings: { fields: [] } };\n`,
        );

        expect(await loadExternalPlugin(dir)).toBe(true);
        expect(registered).toContain('cache-probe');
    });
});
