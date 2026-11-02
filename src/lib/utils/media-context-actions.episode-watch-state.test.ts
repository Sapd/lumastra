// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';

vi.mock('$lib/api/user', () => ({
    markWatched: vi.fn().mockResolvedValue({ error: null }),
    unmarkWatched: vi.fn().mockResolvedValue({ error: null }),
}));
vi.mock('$lib/utils/invalidate-when-idle', () => ({ invalidateWhenIdle: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { info: vi.fn(), error: vi.fn() } }));

import { markWatched, unmarkWatched } from '$lib/api/user';
import { invalidateWhenIdle } from '$lib/utils/invalidate-when-idle';
import { toasts } from '$lib/stores/toast.store';
import { setEpisodeWatchState } from './media-context-actions';

const episode: UniversalMediaItem = {
    id: 'cw-episode',
    title: 'Episode',
    mediaType: 'episode',
    externalIds: { internal: 'episode-uuid' },
    seriesId: 'series-uuid',
    isAvailable: true,
    canRequest: false,
    progress: 86,
};

describe('episode context watch-state actions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([true, false])(
        'does not target the series when episode UUID is missing (watched=%s)',
        async (watched) => {
            await setEpisodeWatchState({ ...episode, externalIds: {} }, watched);
            expect(markWatched).not.toHaveBeenCalled();
            expect(unmarkWatched).not.toHaveBeenCalled();
            expect(invalidateWhenIdle).not.toHaveBeenCalled();
        },
    );

    it('rejects non-episode items', async () => {
        await setEpisodeWatchState({ ...episode, mediaType: 'series' }, true);
        expect(markWatched).not.toHaveBeenCalled();
        expect(invalidateWhenIdle).not.toHaveBeenCalled();
    });

    it.each([true, false])(
        'reports API errors without a success toast or refresh (watched=%s)',
        async (watched) => {
            const api = watched ? markWatched : unmarkWatched;
            vi.mocked(api).mockResolvedValueOnce({
                data: null,
                error: 'request failed',
                status: 500,
            });
            await setEpisodeWatchState(episode, watched);
            expect(api).toHaveBeenCalledWith(
                'episode-uuid',
                ...(watched ? [expect.objectContaining({ mediaType: 'episode' })] : []),
            );
            expect(toasts.error).toHaveBeenCalledOnce();
            expect(toasts.info).not.toHaveBeenCalled();
            expect(invalidateWhenIdle).not.toHaveBeenCalled();
        },
    );

    it.each([true, false])(
        'reports unexpected transport failures (watched=%s)',
        async (watched) => {
            vi.mocked(watched ? markWatched : unmarkWatched).mockRejectedValueOnce(
                new Error('offline'),
            );
            await setEpisodeWatchState(episode, watched);
            expect(toasts.error).toHaveBeenCalledOnce();
            expect(invalidateWhenIdle).not.toHaveBeenCalled();
        },
    );
    it('serializes opposite choices per episode while other episodes remain independent', async () => {
        let completeFirst!: () => void;
        vi.mocked(markWatched).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    completeFirst = () => resolve({ data: null, error: null, status: 200 });
                }),
        );
        const first = setEpisodeWatchState(episode, true);
        const last = setEpisodeWatchState(episode, false);
        await vi.waitFor(() => expect(markWatched).toHaveBeenCalledOnce());
        expect(unmarkWatched).not.toHaveBeenCalled();
        await setEpisodeWatchState(
            { ...episode, externalIds: { internal: 'other-episode' } },
            false,
        );
        expect(unmarkWatched).toHaveBeenCalledExactlyOnceWith('other-episode');
        completeFirst();
        await Promise.all([first, last]);
        expect(unmarkWatched).toHaveBeenLastCalledWith('episode-uuid');
        expect(vi.mocked(markWatched).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(unmarkWatched).mock.invocationCallOrder[1],
        );
        expect(invalidateWhenIdle).toHaveBeenCalledTimes(3);
        // A settled queue must allow a fresh selection too.
        await setEpisodeWatchState(episode, true);
        expect(markWatched).toHaveBeenCalledTimes(2);
    });

    it.each(['api', 'transport'])(
        'runs the queued latest choice after a %s failure',
        async (failure) => {
            let failFirst!: () => void;
            vi.mocked(markWatched).mockImplementationOnce(
                () =>
                    new Promise((resolve, reject) => {
                        failFirst = () => {
                            if (failure === 'transport') reject(new Error('offline'));
                            else resolve({ data: null, error: 'failed', status: 500 });
                        };
                    }),
            );
            const first = setEpisodeWatchState(episode, true);
            const last = setEpisodeWatchState(episode, false);
            await vi.waitFor(() => expect(markWatched).toHaveBeenCalledOnce());
            expect(unmarkWatched).not.toHaveBeenCalled();
            failFirst();
            await Promise.all([first, last]);
            expect(toasts.error).toHaveBeenCalledOnce();
            expect(unmarkWatched).toHaveBeenCalledExactlyOnceWith('episode-uuid');
            expect(invalidateWhenIdle).toHaveBeenCalledOnce();
            await setEpisodeWatchState(episode, true);
            expect(markWatched).toHaveBeenCalledTimes(2);
        },
    );
});
