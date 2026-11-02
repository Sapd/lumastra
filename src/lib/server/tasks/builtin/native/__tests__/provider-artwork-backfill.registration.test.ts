// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The five provider-artwork tasks must register themselves on import, and the
 * autoloader must carry a coreModules entry for the file. A task that is
 * defined but never registered silently does not exist.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { mockRegisterTask } = vi.hoisted(() => ({ mockRegisterTask: vi.fn() }));
vi.mock('../../../registry.js', () => ({ registry: { registerTask: mockRegisterTask } }));
// Keep the Valkey client out of a unit-test process — artwork-rate-budget.ts is
// in the module graph and pulls @valkey/valkey-glide otherwise.
vi.mock('../../../../cache/valkey.js', () => ({
    isValkeyReady: () => false,
    incr: vi.fn(),
    expire: vi.fn(),
    cacheGet: vi.fn(),
}));

import '../provider-artwork-backfill.js';
import { PROVIDER_ARTWORK_STAGE_IDS } from '../provider-artwork-stages.js';

// Snapshot what the import above registered, at module scope. Vitest 5 clears
// mock call history between the collection phase (where these imports run) and
// the execution phase, so reading `mockRegisterTask.mock` inside a test reports
// an empty history even though registration happened at import time — which is
// precisely what this file exists to pin.
const registeredAtImport = mockRegisterTask.mock.calls.map((c) => (c[0] as { id: string }).id);

describe('provider-artwork-backfill registration', () => {
    it('registers all five tasks at import time', () => {
        expect(registeredAtImport).toHaveLength(5);
        const ids = [...registeredAtImport];
        expect(ids.sort()).toEqual([
            'provider-artwork-backdrop',
            'provider-artwork-logo',
            'provider-artwork-poster',
            'provider-artwork-season-poster',
            'provider-artwork-thumb',
        ]);
    });

    it('exports the stage id list used by the migration and the report task', () => {
        expect([...PROVIDER_ARTWORK_STAGE_IDS].sort()).toEqual([
            'provider-artwork-backdrop',
            'provider-artwork-logo',
            'provider-artwork-poster',
            'provider-artwork-season-poster',
            'provider-artwork-thumb',
        ]);
    });

    it('has a string-literal coreModules entry in the builtin autoloader', () => {
        const indexSrc = readFileSync(
            resolve(process.cwd(), 'src/lib/server/tasks/builtin/index.ts'),
            'utf8',
        );
        expect(indexSrc).toContain(
            "['provider-artwork-backfill', () => import('./native/provider-artwork-backfill.js')]",
        );
    });
});
