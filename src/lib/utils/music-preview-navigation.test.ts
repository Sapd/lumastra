// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';

const { state, pushState, replaceState } = vi.hoisted(() => ({
    state: { url: new URL('https://example.test/music?genre=rock'), state: {} as App.PageState },
    pushState: vi.fn(),
    replaceState: vi.fn(),
}));
vi.mock('$app/stores', () => ({ page: writable(state) }));
vi.mock('$app/navigation', () => ({ pushState, replaceState }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
import { openMusicPreview, closeMusicPreview } from './music-preview-navigation';

beforeEach(() => {
    vi.clearAllMocks();
    state.state = {};
    state.url = new URL('https://example.test/music?genre=rock');
});

describe('mix preview history', () => {
    it('keeps filters when opening a shareable preview', () => {
        openMusicPreview('station', 2);
        expect(pushState).toHaveBeenCalledWith(
            'https://example.test/music?genre=rock&station=2',
            expect.objectContaining({ musicPreviewPushed: true }),
        );
    });
    it('opens a string mix id and removes any competing preview', () => {
        state.url = new URL('https://example.test/music?genre=rock&station=2');
        openMusicPreview('mix', 'music-mix-dance');
        expect(pushState).toHaveBeenCalledWith(
            'https://example.test/music?genre=rock&mix=music-mix-dance',
            expect.objectContaining({ musicPreviewPushed: true }),
        );
    });

    it('preserves a deployment base exactly once', () => {
        state.url = new URL('https://example.test/dashboard/music/collections');
        openMusicPreview('collection', 7);
        expect(pushState).toHaveBeenCalledWith(
            'https://example.test/dashboard/music/collections?collection=7',
            expect.anything(),
        );
    });

    it('uses Back only for a preview opened in this session', () => {
        const back = vi.spyOn(history, 'back').mockImplementation(() => {});
        state.state.musicPreviewPushed = true;
        closeMusicPreview('station');
        expect(back).toHaveBeenCalledOnce();
        expect(replaceState).not.toHaveBeenCalled();
        back.mockRestore();
    });
    it('closes a reloaded deep link in place and keeps its filters', () => {
        state.url = new URL('https://example.test/music?genre=rock&station=2');
        closeMusicPreview('station');
        expect(replaceState).toHaveBeenCalledWith(
            'https://example.test/music?genre=rock',
            expect.objectContaining({ musicPreviewUrl: 'https://example.test/music?genre=rock' }),
        );
    });
});
