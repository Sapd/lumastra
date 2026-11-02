// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { PageSection } from '$lib/types/server-driven-ui';
import LiveTvWidget from './LiveTvWidget.svelte';
import { getLiveTvChannels } from '$lib/api/playback.js';
const observed = vi.hoisted(() => ({
    sections: [] as PageSection[],
    canLoadMore: false,
    reachEnd: undefined as (() => void) | undefined,
}));
import { getLiveTvFavorites } from '$lib/api/livetv-favorites.js';
vi.mock('$lib/api/playback.js', () => ({ getLiveTvChannels: vi.fn() }));
vi.mock('$lib/api/livetv-favorites.js', () => ({ getLiveTvFavorites: vi.fn() }));
vi.mock('$lib/components/sections', () => ({
    SectionRenderer: (
        _anchor: Node,
        props: {
            section: PageSection;
            canLoadMore?: boolean;
            onsectionReachEnd?: (event: { section: PageSection }) => void;
        },
    ) => {
        // eslint-disable-next-line no-undef -- Svelte compiler transforms the test module's rune
        $effect(() => {
            observed.sections.push(props.section);
            observed.canLoadMore = props.canLoadMore ?? false;
            observed.reachEnd = () => props.onsectionReachEnd?.({ section: props.section });
        });
    },
}));
const channels = [
    {
        id: 'a',
        feedId: 'feed-a',
        images: {},
        name: 'Affected',
        sourceId: 'outage',
        isVisible: true,
        nowNext: { current: null, next: null },
        sortOrder: 1,
    },
    {
        id: 'b',
        feedId: 'feed-b',
        images: {},
        name: 'Healthy',
        sourceId: 'working',
        isVisible: true,
        nowNext: { current: null, next: null },
        sortOrder: 2,
    },
];
function response(suppressedChannelIds: string[]): Awaited<ReturnType<typeof getLiveTvChannels>> {
    return {
        status: 200,
        error: null,
        data: {
            items: channels,
            page: { limit: 100, offset: 0, total: 2, hasMore: false },
            availability: {
                observedAt: new Date().toISOString(),
                evidenceUnavailable: false,
                sources: [],
                channels: {},
                suppressedChannelIds: suppressedChannelIds.map((id) => `feed-${id}`),
            },
        },
    };
}
function favorites(stationIds: string[]): Awaited<ReturnType<typeof getLiveTvFavorites>> {
    return { status: 200, error: null, data: { stationIds } };
}
function ids(): string[] {
    return observed.sections.at(-1)?.items.map((i) => i.id) ?? [];
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    observed.sections = [];
    observed.canLoadMore = false;
    observed.reachEnd = undefined;
    vi.mocked(getLiveTvFavorites).mockResolvedValue(favorites([]));
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
            observe(): void {
                this.callback([{ isIntersecting: true }]);
            }
            disconnect(): void {}
        },
    );
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
describe('Live TV widget availability refresh', () => {
    it('removes affected cards, keeps healthy providers and readmits recovery', async () => {
        vi.mocked(getLiveTvChannels).mockResolvedValue(response([]));
        render(LiveTvWidget);
        await vi.advanceTimersByTimeAsync(1);
        await tick();
        expect(ids()).toEqual(['a', 'b']);
        vi.mocked(getLiveTvChannels).mockResolvedValue(response(['a']));
        await vi.advanceTimersByTimeAsync(60_000);
        await tick();
        expect(ids()).toEqual(['b']);
        vi.mocked(getLiveTvChannels).mockResolvedValue(response([]));
        await vi.advanceTimersByTimeAsync(60_000);
        await tick();
        expect(ids()).toEqual(['a', 'b']);
    });
    it('ignores older responses after a newer outage refresh', async () => {
        let finish!: (result: Awaited<ReturnType<typeof getLiveTvChannels>>) => void;
        vi.mocked(getLiveTvChannels)
            .mockImplementationOnce(
                () =>
                    new Promise((done) => {
                        finish = done;
                    }),
            )
            .mockResolvedValue(response(['a']));
        render(LiveTvWidget);
        await vi.advanceTimersByTimeAsync(60_001);
        await tick();
        expect(ids()).toEqual(['b']);
        finish(response([]));
        await tick();
        expect(ids()).toEqual(['b']);
    });
});
describe('Live TV widget favorites', () => {
    it('shows favorite channels first', async () => {
        vi.mocked(getLiveTvChannels).mockResolvedValue(response([]));
        vi.mocked(getLiveTvFavorites).mockResolvedValue(favorites(['b']));
        render(LiveTvWidget);
        await vi.advanceTimersByTimeAsync(1);
        await tick();
        expect(ids()).toEqual(['b', 'a']);
    });
    it('keeps the lineup order when favorites fail to load', async () => {
        vi.mocked(getLiveTvChannels).mockResolvedValue(response([]));
        vi.mocked(getLiveTvFavorites).mockResolvedValue({
            status: 500,
            error: { message: 'boom' },
            data: null,
        } as unknown as Awaited<ReturnType<typeof getLiveTvFavorites>>);
        render(LiveTvWidget);
        await vi.advanceTimersByTimeAsync(1);
        await tick();
        expect(ids()).toEqual(['a', 'b']);
    });
});

describe('Live TV widget rendering budget', () => {
    it('renders the large lineup in batches, with favorites first and every station reachable', async () => {
        const lineup = Array.from({ length: 2_386 }, (_, index) => ({
            ...channels[0],
            id: `station-${index}`,
            feedId: `feed-${index}`,
        }));
        const result = response([]);
        result.data!.items = lineup;
        vi.mocked(getLiveTvChannels).mockResolvedValue(result);
        vi.mocked(getLiveTvFavorites).mockResolvedValue(favorites(['station-2385']));
        render(LiveTvWidget);
        await vi.advanceTimersByTimeAsync(1);
        await tick();

        expect(ids()).toHaveLength(20);
        expect(ids()[0]).toBe('station-2385');
        expect(observed.canLoadMore).toBe(true);

        observed.reachEnd?.();
        await tick();
        expect(ids()).toHaveLength(40);

        // A programme refresh must preserve the user's expanded row, rather
        // than resetting it or mounting the rest of the lineup.
        await vi.advanceTimersByTimeAsync(60_000);
        await tick();
        expect(ids()).toHaveLength(40);

        while (observed.canLoadMore) {
            observed.reachEnd?.();
            await tick();
        }
        expect(ids()).toEqual(['station-2385', ...lineup.slice(0, -1).map((ch) => ch.id)]);
    });

    it('also bounds an oversized initial section when the refresh fails', async () => {
        const items = Array.from({ length: 50 }, (_, index) => ({
            id: `station-${index}`,
            title: `Station ${index}`,
            mediaType: 'tvchannel' as const,
            externalIds: { internal: `station-${index}` },
            isAvailable: true,
            canRequest: false,
        }));
        vi.mocked(getLiveTvChannels).mockResolvedValue({
            status: 503,
            data: null,
            error: 'Unavailable',
        });
        render(LiveTvWidget, {
            initialSection: { id: 'live-tv', type: 'carousel', items },
        });
        await vi.advanceTimersByTimeAsync(1);
        await tick();

        expect(ids()).toEqual(items.slice(0, 20).map((item) => item.id));
        expect(observed.canLoadMore).toBe(true);
    });
});
