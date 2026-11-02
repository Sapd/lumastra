// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getWatchUrl, navigateToWatch } from './watch-navigation';

// Mock SvelteKit modules required by watch-navigation
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/stores', () => ({
    page: { subscribe: vi.fn(() => () => {}) },
}));
vi.mock('$lib/stores/playerNavigation', () => ({
    saveReturnPath: vi.fn(),
}));

const gotoMock = vi.fn();
vi.mock('$app/navigation', () => ({
    goto: gotoMock,
}));

describe('getWatchUrl', () => {
    it('returns /watch/mediaKey', () => {
        const url = getWatchUrl('a3f5e8c7-uuid');
        expect(url).toBe('/watch/a3f5e8c7-uuid');
    });
});

describe('navigateToWatch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('does nothing when mediaKey is empty', async () => {
        await navigateToWatch('');
        expect(gotoMock).not.toHaveBeenCalled();
    });

    it('calls goto with /watch/UUID', async () => {
        const { saveReturnPath } = await import('$lib/stores/playerNavigation');
        await navigateToWatch('a3f5e8c7-uuid');
        expect(saveReturnPath).toHaveBeenCalledOnce();
        expect(gotoMock).toHaveBeenCalledWith('/watch/a3f5e8c7-uuid');
    });

    it('appends ?t= for a start position (chapter play) and saves the return path', async () => {
        const { saveReturnPath } = await import('$lib/stores/playerNavigation');
        await navigateToWatch('a3f5e8c7-uuid', 'movie', { startSeconds: 125.9 });
        expect(saveReturnPath).toHaveBeenCalledOnce();
        expect(gotoMock).toHaveBeenCalledWith('/watch/a3f5e8c7-uuid?t=125');
    });

    it('omits ?t= for a zero or invalid start position', async () => {
        await navigateToWatch('a3f5e8c7-uuid', 'movie', { startSeconds: 0 });
        await navigateToWatch('a3f5e8c7-uuid', 'movie', { startSeconds: Number.NaN });
        expect(gotoMock).toHaveBeenNthCalledWith(1, '/watch/a3f5e8c7-uuid');
        expect(gotoMock).toHaveBeenNthCalledWith(2, '/watch/a3f5e8c7-uuid');
    });

    it('uses mediaKey as the ID in the URL', async () => {
        const { saveReturnPath } = await import('$lib/stores/playerNavigation');
        await navigateToWatch('internal-uuid-123');
        expect(saveReturnPath).toHaveBeenCalledOnce();
        expect(gotoMock).toHaveBeenCalledWith('/watch/internal-uuid-123');
    });

    it('keeps a video mediaType on the watch route', async () => {
        const { saveReturnPath } = await import('$lib/stores/playerNavigation');
        await navigateToWatch('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'movie');
        expect(saveReturnPath).toHaveBeenCalledOnce();
        expect(gotoMock).toHaveBeenCalledWith('/watch/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    });

    for (const mediaType of ['audiobook', 'AudioBook', 'AUDIOBOOK']) {
        it(`refuses mediaType='${mediaType}' before touching watch navigation`, async () => {
            const { saveReturnPath } = await import('$lib/stores/playerNavigation');
            await navigateToWatch('11111111-2222-4333-8444-555555555555', mediaType);
            expect(saveReturnPath).not.toHaveBeenCalled();
            expect(gotoMock).not.toHaveBeenCalled();
        });
    }

    it('refuses a composite audiobook key even when no mediaType is supplied', async () => {
        const { saveReturnPath } = await import('$lib/stores/playerNavigation');
        await navigateToWatch('tmdb:123:audiobook');
        expect(saveReturnPath).not.toHaveBeenCalled();
        expect(gotoMock).not.toHaveBeenCalled();
    });
});
