// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import ModalMovie from './ModalMovie.svelte';
import type { EnrichedModalData } from '$lib/utils/modal-data';

const mocks = vi.hoisted(() => ({ enrich: vi.fn() }));

vi.mock('$app/stores', () => ({
    page: writable({
        data: { features: { social: false, socialReviews: false }, user: {} },
        url: new URL('http://localhost/'),
    }),
}));

// Keep the actual parent, header and data composable. Only unrelated sections
// and the asynchronous data-fetch boundary are replaced.
vi.mock('$lib/components/modal', async () => {
    const empty = (await import('./__fixtures__/EmptyModalSection.svelte')).default;
    return {
        ModalHeader: (await import('./components/modal/ModalHeader.svelte')).default,
        ModalActions: empty,
        ModalBody: empty,
        ModalAudiobookDetails: empty,
        ModalAudiobookSeries: empty,
        ModalSeasons: empty,
        SetSeriesProgressModal: empty,
    };
});
vi.mock('$lib/components/media', async () => ({
    SeriesEpisodePicker: (await import('./__fixtures__/EmptyModalSection.svelte')).default,
}));
vi.mock('$lib/utils/modal-data', async (original) => ({
    ...(await original<typeof import('$lib/utils/modal-data')>()),
    enrichMediaData: mocks.enrich,
    fetchSimilarContent: vi.fn(async () => []),
    fetchSocialActivity: vi.fn(async () => []),
    fetchAudiobookSocialActivity: vi.fn(async () => []),
    fetchUserRating: vi.fn(async () => null),
    fetchWatchedStatus: vi.fn(async () => false),
    fetchNextEpisode: vi.fn(async () => null),
}));

const primary = 'The Worst Witch';
const alternative = 'Eine lausige Hexe';
const uuid = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function viewport(width: number): void {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    vi.stubGlobal('matchMedia', (media: string) => ({
        media,
        matches: width < 1024,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    }));
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            observe(): void {}
            disconnect(): void {}
        },
    );
}

describe('search title context through the real detail parent', () => {
    for (const layout of ['desktop-single', 'desktop-split', 'mobile'] as const) {
        for (const enrichedTitle of [primary, alternative]) {
            it(`${layout}: retains context and suppresses duplicates after enrichment to ${enrichedTitle}`, async () => {
                viewport(layout === 'mobile' ? 390 : 1440);
                if (layout === 'desktop-single')
                    localStorage.setItem('lumastra:modal:episodeLayout', 'single');

                let resolveEnrichment!: (value: EnrichedModalData) => void;
                mocks.enrich.mockReturnValue(
                    new Promise<EnrichedModalData>((resolve) => {
                        resolveEnrichment = resolve;
                    }),
                );
                const { container } = render(ModalMovie, {
                    modalId: 'search-match',
                    title: primary,
                    matchedTitle: alternative,
                    body: '',
                    image: '/poster.jpg',
                    mediaType: 'SERIES',
                    externalIds: { tmdb: '123' },
                });

                await waitFor(() => expect(mocks.enrich).toHaveBeenCalledTimes(1));
                const titleRegion = (): HTMLElement => {
                    const selector =
                        layout === 'mobile'
                            ? '.mobile-backdrop-title'
                            : layout === 'desktop-split' &&
                                container.querySelector('.split-left-pane')
                              ? '.split-left-pane'
                              : '.modal-content';
                    const region = container.querySelector<HTMLElement>(selector);
                    expect(region).not.toBeNull();
                    return region!;
                };
                expect(within(titleRegion()).getByRole('heading', { name: primary })).toBeTruthy();
                expect(within(titleRegion()).getByText(alternative)).toBeTruthy();

                resolveEnrichment({
                    _enriched: true,
                    title: enrichedTitle,
                    overview: 'Fresh detail description',
                    externalIds: { tmdb: '123', internal: uuid },
                });
                await waitFor(() => {
                    if (layout === 'desktop-split')
                        expect(container.querySelector('.split-left-pane')).not.toBeNull();
                    expect(
                        within(titleRegion()).getByRole('heading', { name: enrichedTitle }),
                    ).toBeTruthy();
                    expect(within(titleRegion()).getAllByText(alternative)).toHaveLength(1);
                    if (enrichedTitle === primary)
                        expect(
                            within(titleRegion()).getByRole('heading', { name: primary }),
                        ).toBeTruthy();
                });
            });
        }
    }
});
