// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owners: packages 8/5/11. A package that changes this area updates this recipe in the same commit.
import { test, expect } from 'vitest';
import { client, episode, expectOk } from './client';
import { playEpisode, clearProgress } from './playback';
test('05 progress from recipe 04 is resumable', async (ctx) => {
    const item = await episode();
    if (!item) return ctx.skip('Instance has no playable episodes');
    // Repeat 04's flow so this recipe also works alone and has no test-file ordering dependency.
    try {
        await playEpisode(item.id);
        const state = expectOk(
            'GET',
            '/watch-state/{id}',
            await client.GET('/api/v1/watch-state/{id}', { params: { path: { id: item.id } } }),
        );
        expect(state.positionMs).toBeGreaterThan(0);
        expectOk('GET', '/continue-watching', await client.GET('/api/v1/continue-watching'));
    } finally {
        await clearProgress(item.id);
    }
});
