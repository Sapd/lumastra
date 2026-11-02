// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { bumpWatchStateVersion, watchStateVersion } from '$lib/stores/watch-state-version';
import type { ModalDataProps } from '$lib/composables/use-modal-data.svelte';
const mocks = vi.hoisted(() => ({
    context: vi.fn(),
    toggle: vi.fn(),
    next: vi.fn(),
    explicit: vi.fn(),
}));
vi.mock('$lib/api/content', () => ({ getMediaContext: mocks.context }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/utils/modal-data', async (importActual) => ({
    ...(await importActual<typeof import('$lib/utils/modal-data')>()),
    needsEnrichment: () => false,
    toggleWatchedStatus: mocks.toggle,
    fetchNextEpisode: mocks.next,
    fetchExplicitEpisode: mocks.explicit,
    fetchUserRating: vi.fn().mockResolvedValue(null),
    fetchWatchedStatus: vi.fn().mockResolvedValue(false),
}));
import EpisodeCountHarness from './EpisodeCountHarness.svelte';
function props(id = 'a'): ModalDataProps {
    return {
        modalId: id,
        title: id,
        body: '',
        image: '',
        mediaType: 'series',
        externalIds: { internal: id },
        episodeCount: 10,
        availableEpisodeCount: 2,
        watchedEpisodeCount: 0,
        unwatchedEpisodeCount: 2,
    };
}
function context(unwatched: number, id = 'a') {
    return {
        data: {
            details: {
                type: 'series',
                title: id,
                episodeCount: 10,
                availableEpisodeCount: 2,
                watchedEpisodeCount: 2 - unwatched,
                unwatchedEpisodeCount: unwatched,
            },
            watched: { watched: false },
            rating: { rating: null },
            nextEpisode: { id: `${id}-first`, seasonNumber: 1, episodeNumber: 1 },
        },
        error: null,
    };
}
function deferred() {
    let resolve!: (value: ReturnType<typeof context>) => void;
    const promise = new Promise<ReturnType<typeof context>>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
describe('mounted modal count refresh', () => {
    beforeEach(() => {
        watchStateVersion.set(0);
        vi.clearAllMocks();
        mocks.context.mockResolvedValue(context(2));
        mocks.next.mockResolvedValue({ id: 'a-second', seasonNumber: 1, episodeNumber: 2 });
        mocks.explicit.mockResolvedValue(null);
    });
    afterEach(cleanup);
    it.each([
        { seasonNumber: null, episodeNumber: 1 },
        { seasonNumber: 1, episodeNumber: null },
    ])(
        'falls back to the selected episode when context coordinates are $seasonNumber/$episodeNumber',
        async (coordinates) => {
            mocks.context.mockResolvedValue({
                ...context(2),
                data: {
                    ...context(2).data,
                    nextEpisode: { id: 'invalid-context-episode', ...coordinates },
                },
            });
            let resolveExplicit!: (value: {
                id: string;
                seasonNumber: number;
                episodeNumber: number;
            }) => void;
            mocks.explicit.mockReturnValue(
                new Promise((resolve) => {
                    resolveExplicit = resolve;
                }),
            );
            const { component } = render(EpisodeCountHarness, {
                value: { ...props(), seasonNumber: 2, episodeNumber: 5 },
            });

            await vi.waitFor(() => expect(mocks.explicit).toHaveBeenCalledWith('a', 2, 5));
            expect(screen.getByTestId('next').textContent).toBe('none');
            expect(component.getModal().nextEpisodeId).toBeNull();
            expect(mocks.next).not.toHaveBeenCalled();

            resolveExplicit({ id: 'selected-episode', seasonNumber: 2, episodeNumber: 5 });
            await vi.waitFor(() =>
                expect(screen.getByTestId('next').textContent).toBe('selected-episode'),
            );
            expect(component.getModal().nextEpisode).toMatchObject({
                seasonNumber: 2,
                episodeNumber: 5,
                playable: true,
            });
        },
    );
    it.each([
        { seasonNumber: null, episodeNumber: 1 },
        { seasonNumber: 1, episodeNumber: null },
    ])(
        'does not expose incomplete context coordinates $seasonNumber/$episodeNumber as Next Up',
        async (coordinates) => {
            mocks.context.mockResolvedValue({
                ...context(2),
                data: {
                    ...context(2).data,
                    nextEpisode: { id: 'invalid-context-episode', ...coordinates },
                },
            });
            let resolveNext!: (value: {
                id: string;
                seasonNumber: number;
                episodeNumber: number;
            }) => void;
            mocks.next.mockReturnValue(
                new Promise((resolve) => {
                    resolveNext = resolve;
                }),
            );
            // No explicit episode: only the null-coordinate guard can reject
            // the context result and unlock the ordinary Next Up fallback.
            const { component } = render(EpisodeCountHarness, { value: props() });

            await vi.waitFor(() => expect(mocks.next).toHaveBeenCalledWith('a'));
            expect(screen.getByTestId('next').textContent).toBe('none');
            expect(component.getModal().nextEpisodeId).toBeNull();
            expect(component.getModal().nextEpisode).toBeNull();
            expect(mocks.explicit).not.toHaveBeenCalled();

            resolveNext({ id: 'valid-next-episode', seasonNumber: 1, episodeNumber: 2 });
            await vi.waitFor(() =>
                expect(screen.getByTestId('next').textContent).toBe('valid-next-episode'),
            );
            expect(component.getModal().nextEpisode).toEqual({
                seasonNumber: 1,
                episodeNumber: 2,
                playable: true,
            });
        },
    );
    it('updates self-mutation counts without advancing the retained Next Up used by Undo', async () => {
        const { component } = render(EpisodeCountHarness, { value: props() });
        await vi.waitFor(() => expect(screen.getByTestId('next').textContent).toBe('a-first'));
        mocks.context.mockResolvedValue({
            ...context(1),
            data: {
                ...context(1).data,
                nextEpisode: { id: 'a-second', seasonNumber: 1, episodeNumber: 2 },
            },
        });
        mocks.toggle.mockImplementation(async () => {
            bumpWatchStateVersion();
            return true;
        });
        await component.getModal().markNextEpisodeWatched('a-first');
        await vi.waitFor(() => expect(screen.getByTestId('unwatched').textContent).toBe('1'));
        expect(screen.getByTestId('next').textContent).toBe('a-first');
        expect(mocks.context).toHaveBeenLastCalledWith(expect.any(String), ['details']);
        mocks.context.mockResolvedValue(context(2));
        mocks.toggle.mockImplementation(async () => {
            bumpWatchStateVersion();
            return false;
        });
        expect(await component.getModal().markEpisodeUnwatched('a-first')).toBe(true);
        await vi.waitFor(() => expect(screen.getByTestId('unwatched').textContent).toBe('2'));
    });
    it('queues a watch mutation while initial context is pending', async () => {
        const initial = deferred();
        mocks.context.mockReturnValueOnce(initial.promise).mockResolvedValue(context(0));
        render(EpisodeCountHarness, { value: props() });
        await vi.waitFor(() => expect(mocks.context).toHaveBeenCalledTimes(1));
        bumpWatchStateVersion();
        initial.resolve(context(2));
        await vi.waitFor(() => expect(screen.getByTestId('unwatched').textContent).toBe('0'));
        expect(mocks.context).toHaveBeenCalledTimes(2);
    });
    it('rejects a deferred refresh after identity changes', async () => {
        const oldRefresh = deferred();
        const { rerender } = render(EpisodeCountHarness, { value: props() });
        await vi.waitFor(() => expect(screen.getByTestId('next').textContent).toBe('a-first'));
        mocks.context.mockReturnValueOnce(oldRefresh.promise).mockResolvedValue(context(1, 'b'));
        bumpWatchStateVersion();
        await vi.waitFor(() => expect(mocks.context).toHaveBeenCalledTimes(2));
        await rerender({ value: props('b') });
        await vi.waitFor(() => expect(screen.getByTestId('next').textContent).toBe('b-first'));
        oldRefresh.resolve(context(0));
        await tick();
        expect(screen.getByTestId('unwatched').textContent).toBe('1');
    });
    it('clears stale personal counts when a successful optional-count refresh has unknown fields', async () => {
        render(EpisodeCountHarness, { value: props() });
        await vi.waitFor(() => expect(screen.getByTestId('next').textContent).toBe('a-first'));
        mocks.context.mockResolvedValue({
            data: { details: { type: 'series', title: 'a', episodeCount: 10 } },
            error: null,
        });
        bumpWatchStateVersion();
        await vi.waitFor(() => expect(screen.getByTestId('unwatched').textContent).toBe('unknown'));
        expect(screen.getByTestId('total').textContent).toBe('10');
    });
});
