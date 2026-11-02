// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owners: packages 8/5. A package that changes this area updates this recipe in the same commit.
import { test } from 'vitest';
import { episode } from './client';
import { playEpisode, clearProgress } from './playback';
test('04 start episode → stream → progress → stop', async (ctx) => {
    const item = await episode();
    if (!item) return ctx.skip('Instance has no playable episodes');
    try {
        await playEpisode(item.id);
    } finally {
        await clearProgress(item.id);
    }
});
