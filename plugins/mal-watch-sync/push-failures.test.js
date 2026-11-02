// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import plugin from './index.js';

// initFromCtx() (index.js) requires ctx.sql and ctx.userCredentials to be
// truthy before it will populate the module-level bindings; neither is
// actually invoked on the missing-username branch below, so stubs suffice.
describe('mal pushWatchState failedItems', () => {
    it('records a transient failedItems entry for an item with no username', async () => {
        const ctx = {
            sql: async () => [],
            logger: { info() {}, warn() {}, debug() {}, error() {} },
            secrets: {},
            userCredentials: {},
            // No HTTP call is reached (the item has no username and is
            // recorded as a failure before any request), but initFromCtx()
            // requires ctx.http regardless — see C22 fix round 1's ctx.http
            // migration.
            http: { get: async () => new Response(null), post: async () => new Response(null) },
            // initFromCtx() also requires ctx.catalog (always present on a real
            // PluginContext — see resolve-ids-persists-live-search.test.js).
            catalog: { upsertExternalId: async () => {} },
        };
        const res = await plugin.pushWatchState(ctx, [
            {
                providerId: '1',
                mediaId: 'media-x',
                username: '',
                isWatched: true,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 1,
            },
        ]);
        expect(res.failed).toBe(1);
        expect(res.failedItems).toContainEqual(
            expect.objectContaining({ mediaId: 'media-x', terminal: false }),
        );
    });
});
