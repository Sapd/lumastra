// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerController } from './player-controller.svelte';
import { playerStore } from './playerStore.svelte';
import type { NextEpisodeInfo } from '$lib/types/playback';

const { getNextEpisodeAfterPlayback } = vi.hoisted(() => ({
    getNextEpisodeAfterPlayback: vi.fn(),
}));
vi.mock('$lib/api/content.js', () => ({ getNextEpisodeAfterPlayback }));

interface AutoplayController {
    resolveFollowingEpisode(
        series: string,
        after: NextEpisodeInfo,
        name?: string,
    ): Promise<NextEpisodeInfo | null>;
    resolveAndApplyFollowingEpisode(
        series: string,
        after: NextEpisodeInfo,
        name?: string,
    ): Promise<void>;
    currentPlaybackInfo: { itemId: string };
}

const COMBINED_ID = '11111111-1111-4111-8111-111111111111';

const after: NextEpisodeInfo = {
    itemId: COMBINED_ID,
    internalId: COMBINED_ID,
    title: 'Combined',
    seasonNumber: 5,
    episodeNumber: 10,
    isNewSeason: false,
    hasPrimaryImage: false,
};

function controller(): AutoplayController {
    const target = Object.create(PlayerController.prototype);
    Object.defineProperties(target, {
        currentPlaybackInfo: { value: { itemId: after.itemId }, writable: true },
        mediaSessionCtrl: { value: { deps: {}, setup: vi.fn() } },
        log: { value: vi.fn() },
    });
    return target as AutoplayController;
}

beforeEach(() => {
    vi.clearAllMocks();
    getNextEpisodeAfterPlayback.mockResolvedValue({
        data: {
            id: 'following',
            title: 'Following',
            seasonNumber: 5,
            episodeNumber: 13,
            images: {},
        },
    });
});

describe('audio-only subsequent autoplay resolution', () => {
    it('uses the whole-file playback cursor after an in-place combined episode hop', async () => {
        const target = controller();
        const setNext = vi.spyOn(playerStore, 'setNextEpisode');
        await target.resolveAndApplyFollowingEpisode('series', after, 'Show');
        expect(getNextEpisodeAfterPlayback).toHaveBeenCalledWith('series', COMBINED_ID);
        expect(setNext).toHaveBeenCalledWith(
            expect.objectContaining({
                itemId: 'following',
                seasonNumber: 5,
                episodeNumber: 13,
                isNewSeason: false,
            }),
        );
        setNext.mockRestore();
    });

    it('marks season transitions using effective display seasons', async () => {
        getNextEpisodeAfterPlayback.mockResolvedValue({
            data: {
                id: 'following',
                title: 'Following',
                seasonNumber: 6,
                episodeNumber: 1,
                images: {},
            },
        });
        expect(await controller().resolveFollowingEpisode('series', after)).toMatchObject({
            itemId: 'following',
            isNewSeason: true,
        });
    });

    it('does not apply a late response after another navigation', async () => {
        const target = controller();
        const setNext = vi.spyOn(playerStore, 'setNextEpisode');
        getNextEpisodeAfterPlayback.mockImplementation(async () => {
            target.currentPlaybackInfo = { itemId: 'elsewhere' };
            return {
                data: { id: 'late', title: 'Late', seasonNumber: 5, episodeNumber: 13, images: {} },
            };
        });
        await target.resolveAndApplyFollowingEpisode('series', after);
        expect(setNext).not.toHaveBeenCalled();
        setNext.mockRestore();
    });

    it('ends the chain on lookup failure or the final file', async () => {
        getNextEpisodeAfterPlayback.mockResolvedValue({ error: 'not found', data: null });
        expect(await controller().resolveFollowingEpisode('series', after)).toBeNull();
        getNextEpisodeAfterPlayback.mockRejectedValue(new Error('offline'));
        expect(await controller().resolveFollowingEpisode('series', after)).toBeNull();
    });

    it('sends the internal UUID when itemId is not a UUID', async () => {
        const target = controller();
        await target.resolveFollowingEpisode('series', {
            ...after,
            itemId: 'jellyfin-abc123',
        });
        expect(getNextEpisodeAfterPlayback).toHaveBeenCalledWith('series', COMBINED_ID);
    });

    it('skips the call when no id is a UUID', async () => {
        const result = await controller().resolveFollowingEpisode('series', {
            ...after,
            itemId: 'jellyfin-abc123',
            internalId: undefined,
        });
        expect(result).toBeNull();
        expect(getNextEpisodeAfterPlayback).not.toHaveBeenCalled();
    });

    it('retries once on a 5xx and uses the retry result', async () => {
        getNextEpisodeAfterPlayback
            .mockResolvedValueOnce({ data: null, error: 'boom', status: 503 })
            .mockResolvedValueOnce({
                data: {
                    id: 'following',
                    title: 'Following',
                    seasonNumber: 5,
                    episodeNumber: 13,
                    images: {},
                },
                error: null,
                status: 200,
            });
        expect(await controller().resolveFollowingEpisode('series', after)).toMatchObject({
            itemId: 'following',
        });
        expect(getNextEpisodeAfterPlayback).toHaveBeenCalledTimes(2);
    });

    it('gives up after a single retry when the 5xx persists', async () => {
        getNextEpisodeAfterPlayback.mockResolvedValue({ data: null, error: 'boom', status: 500 });
        expect(await controller().resolveFollowingEpisode('series', after)).toBeNull();
        expect(getNextEpisodeAfterPlayback).toHaveBeenCalledTimes(2);
    });

    it.each([404, 422])('does not retry a %i', async (status) => {
        getNextEpisodeAfterPlayback.mockResolvedValue({ data: null, error: 'no', status });
        expect(await controller().resolveFollowingEpisode('series', after)).toBeNull();
        expect(getNextEpisodeAfterPlayback).toHaveBeenCalledTimes(1);
    });
});
