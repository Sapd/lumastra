// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import mod from './index.js';
const plugin = mod.default ?? mod;

describe('trakt pushWatchState failedItems', () => {
    it('records a terminal failedItems entry for an invalid Trakt id', async () => {
        // Stub credential lookup so we reach the per-item validation loop
        // without any real HTTP call. initFromCtx() requires ctx.sql to be
        // truthy (declares `capabilities: { database: true }`); the media_type
        // lookup it drives is wrapped in try/catch inside pushWatchState and
        // degrades to "default everything to movies" on failure, so a
        // rejecting stub is sufficient here.
        const ctx = {
            logger: { info() {}, warn() {}, debug() {} },
            userCredentials: {
                get: vi.fn(async () => 'stub-token'),
            },
            sql: vi.fn(() => Promise.reject(new Error('no db in test'))),
            // No HTTP call is reached (the item is invalid and drained first),
            // but initFromCtx() requires ctx.http regardless — see C22 fix
            // round 1's ctx.http migration.
            http: { get: vi.fn(), post: vi.fn() },
        };
        const res = await plugin.pushWatchState(ctx, [
            {
                providerId: 'not-a-number',
                mediaId: 'media-y',
                username: 'u1',
                isWatched: true,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 1,
            },
        ]);
        expect(res.failedItems).toContainEqual(
            expect.objectContaining({ mediaId: 'media-y', terminal: true }),
        );
        // The item must actually be drained (engine marks backing events
        // pushed and stops retrying) rather than just recorded as failed —
        // recordFailure alone would leave it retried every cycle forever.
        expect(res.drainedAsSkipped).toContainEqual(
            expect.objectContaining({ username: 'u1', mediaId: 'media-y' }),
        );
    });
});
