// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Smoke test: verify jellyfin watch-sync registers in the new task registry.
 *
 * Note: native plugin files register directly into the module-singleton
 * `registry`, not into an injected registry argument. The `loadBuiltins(reg)`
 * parameter is only for the summary log; `registerWatchSyncWithAutoTasks`
 * defaults to the same singleton. We check the singleton here.
 */
import { describe, it, expect } from 'vitest';
import { registry } from '../../../registry.js';
import { loadBuiltins, _resetLoadedForTests } from '../../index.js';

describe('jellyfin watch-sync registration (new task registry)', () => {
    it('registers jellyfin watch-sync via loadBuiltins', async () => {
        _resetLoadedForTests();
        await loadBuiltins();

        const watchSyncs = registry.getAllWatchSyncs();
        console.log(
            'Watch syncs registered:',
            watchSyncs.map((ws) => ws.id),
        );
        expect(watchSyncs.length).toBeGreaterThan(0);
        expect(watchSyncs.some((ws) => ws.id === 'jellyfin-watch-sync')).toBe(true);
        // loadBuiltins imports ~40 native plugin modules cold under the vitest
        // transform; give it headroom beyond the default 10s in isolation.
    }, 60_000);
});
