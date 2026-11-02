// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { musicTrackFromCard } from '$lib/utils/music-track';

import {
    describe,
    test,
    expect,
    vi,
    beforeEach,
    afterEach,
} from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/svelte';

// SectionSkeleton / SectionRenderer import $env/dynamic/public transitively.
vi.mock('$env/dynamic/public', () => ({ env: {} }));

// Stub SectionRenderer so the test doesn't pull in the full SvelteKit tree.
vi.mock('$lib/components/sections', async () => {
    const { default: SectionRenderer } = await import('./SectionRendererStub.svelte');
    return { SectionRenderer };
});

// Stub mapMusicTrackToItem — returns a minimal UniversalMediaItem.
vi.mock('$lib/utils/mapMusicTrackToItem', () => ({
    mapMusicTrackToItem: (t: { id: string; title: string; artists: { title: string }[] }) => ({
        id: t.id,
        itemKey: `search-${t.id}`,
        externalIds: {},
        mediaType: 'track',
        title: t.title,
        subtitle: t.artists.map((a) => a.title).join(', '),
        overview: t.artists.map((a) => a.title).join(', '),
        image: `/api/image/catalog/${t.id}?size=thumb`,
        aspectRatio: 'square',
        isAvailable: true,
        canRequest: false,
    }),
}));

// Stub getCatalogPosterUrl used indirectly via image-utils (safety).
vi.mock('$lib/utils/image-utils', () => ({
    getCatalogPosterUrl: (id: string) => `/api/image/catalog/${id}?size=thumb`,
}));

// Stub paraglide messages so the component doesn't need the full runtime.
// Spreads the real module first: UniversalMediaCard.svelte (rendered via the
// mocked SectionRenderer's real children in some paths) now statically pulls
// in TrackTitleLine.svelte -> modal-utils.ts, whose module-level
// TMDB_GENRE_MAP calls m.genre_action() etc. at import time — an
// override-only mock throws on any key it doesn't list.
vi.mock('$lib/paraglide/messages', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/paraglide/messages')>();
    return {
        ...actual,
        music_semantic_sounds_like: () => 'Sounds like…',
        music_semantic_lyrics_about: () => 'Lyrics about…',
        music_semantic_empty_sound: ({ query }: { query: string }) =>
            `No sonic matches for "${query}".`,
        music_semantic_empty_sound_hint: () =>
            'Sonic embeddings must be computed first — run the Sonic Embedding Backfill task from Admin → Tasks.',
        music_semantic_empty_lyrics: ({ query }: { query: string }) =>
            `No lyric matches for "${query}".`,
    };
});

// The component uses searchMusicByText / searchMusicByLyrics from the typed API
// client (via useEmbeddingSearch.svelte.ts). Mock the music API module so tests
// control the ApiResult without touching raw fetch.
vi.mock('$lib/api/music.js', () => ({
    searchMusicByText: vi.fn(),
    searchMusicByLyrics: vi.fn(),
}));

import { searchMusicByText } from '$lib/api/music.js';
import SemanticSearchSection from './SemanticSearchSection.svelte';

const ENDPOINT = '/api/music/text-search';

const fakePage = { limit: 30, truncated: false };

const fakeTrack = musicTrackFromCard({
    id: 'track-1',
    type: 'track' as const,
    title: 'Test Track',
    artists: [{ id: null, title: 'Test Artist' }],
    images: { primary: { href: '/img/full', variants: { thumb: '/img/thumb' }, revision: '1', source: 'self' } },

});

/** Successful ApiResult with one track item. */
const fakeSuccessResult = {
    data: { items: [{ ...fakeTrack, similarityScore: 0.9 }], page: fakePage },
    error: null,
    status: 200,
};

/** Successful ApiResult with no track items (empty response). */
const fakeEmptyResult = {
    data: { items: [], page: fakePage },
    error: null,
    status: 200,
};

/** Error ApiResult simulating a 404. */
const fake404Result = {
    data: null,
    error: 'Not found',
    status: 404,
};

function defaultProps(overrides: Record<string, unknown> = {}) {
    return {
        kind: 'sound' as const,
        endpoint: ENDPOINT,
        query: 'calm piano',
        enabled: true,
        ...overrides,
    };
}

describe('SemanticSearchSection', () => {
    beforeEach(() => {
        vi.mocked(searchMusicByText).mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('renders nothing when enabled=false (no fetch)', () => {
        const { container } = render(SemanticSearchSection, {
            props: defaultProps({ enabled: false }),
        });
        const btn = container.querySelector('[data-testid="semantic-section-sound"]');
        expect(btn).toBeNull();
        expect(vi.mocked(searchMusicByText)).not.toHaveBeenCalled();
    });

    test('renders the disclosure button when enabled=true', () => {
        const { container } = render(SemanticSearchSection, {
            props: defaultProps(),
        });
        const btn = container.querySelector('[data-testid="semantic-section-sound"]');
        expect(btn).toBeTruthy();
        expect(btn?.getAttribute('aria-expanded')).toBe('false');
    });

    test('collapsed by default — no fetch even with non-empty query', () => {
        render(SemanticSearchSection, { props: defaultProps() });
        expect(vi.mocked(searchMusicByText)).not.toHaveBeenCalled();
    });

    test('expand fires exactly one fetch to endpoint?q=…&limit=30', async () => {
        vi.mocked(searchMusicByText).mockResolvedValue(fakeSuccessResult);

        const { container } = render(SemanticSearchSection, { props: defaultProps() });
        const btn = container.querySelector('[data-testid="semantic-section-sound"]')!;
        await fireEvent.click(btn);

        await waitFor(() => {
            expect(vi.mocked(searchMusicByText)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(searchMusicByText)).toHaveBeenCalledWith(
                'calm piano',
                30,
                expect.any(AbortSignal),
            );
        });
    });

    test('re-expanding the same query does NOT fire a second fetch', async () => {
        vi.mocked(searchMusicByText).mockResolvedValue(fakeSuccessResult);

        const { container } = render(SemanticSearchSection, { props: defaultProps() });
        const btn = container.querySelector('[data-testid="semantic-section-sound"]')!;

        // Expand → fetch
        await fireEvent.click(btn);
        await waitFor(() => expect(vi.mocked(searchMusicByText)).toHaveBeenCalledTimes(1));

        // Collapse
        await fireEvent.click(btn);
        // Re-expand — same query, cached result
        await fireEvent.click(btn);

        // Still only 1 fetch total
        expect(vi.mocked(searchMusicByText)).toHaveBeenCalledTimes(1);
    });

    test('query change mid-flight calls abort and resets expanded', async () => {
        const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

        // Never resolve so we stay mid-flight
        vi.mocked(searchMusicByText).mockReturnValue(new Promise(() => {}));

        const { container, rerender } = render(SemanticSearchSection, {
            props: defaultProps(),
        });
        const btn = container.querySelector('[data-testid="semantic-section-sound"]')!;

        // Start the in-flight request
        await fireEvent.click(btn);

        // Change the query — effect cleanup should abort and collapse
        await rerender({ ...defaultProps(), query: 'heavy metal' });

        expect(abortSpy).toHaveBeenCalled();

        // After re-render the button should be collapsed
        await waitFor(() => {
            const updatedBtn = container.querySelector('[data-testid="semantic-section-sound"]');
            expect(updatedBtn?.getAttribute('aria-expanded')).toBe('false');
        });
    });

    test('404 response shows neutral error banner, does not throw', async () => {
        vi.mocked(searchMusicByText).mockResolvedValue(fake404Result);

        const { container, findByRole } = render(SemanticSearchSection, {
            props: defaultProps(),
        });
        const btn = container.querySelector('[data-testid="semantic-section-sound"]')!;
        await fireEvent.click(btn);

        // Should show an alert with the error text
        const alert = await findByRole('alert');
        expect(alert).toBeTruthy();
        expect(alert.textContent).toMatch(/Not found/);
    });

    test('successful response renders SectionRenderer with carousel meta', async () => {
        vi.mocked(searchMusicByText).mockResolvedValue(fakeSuccessResult);

        const { container } = render(SemanticSearchSection, { props: defaultProps() });
        const btn = container.querySelector('[data-testid="semantic-section-sound"]')!;
        await fireEvent.click(btn);

        // Wait for the stub to appear
        await waitFor(() => {
            const stub = container.querySelector('[data-testid="section-renderer-stub"]');
            expect(stub).toBeTruthy();
            // The stub sets data-section-id from section.id
            expect(stub?.getAttribute('data-section-id')).toBe('music-sound-search');
        });
    });

    // Fix 1: response with empty items must not throw and must show empty state.
    test('response missing tracks field does not throw and shows empty state', async () => {
        vi.mocked(searchMusicByText).mockResolvedValue(fakeEmptyResult);

        const { container } = render(SemanticSearchSection, { props: defaultProps() });
        const btn = container.querySelector('[data-testid="semantic-section-sound"]')!;
        await fireEvent.click(btn);

        // Should show empty state, not throw
        await waitFor(() => {
            const stub = container.querySelector('[data-testid="section-renderer-stub"]');
            expect(stub).toBeNull(); // no tracks → no renderer
            // The panel must be visible (expanded) and contain empty-state copy
            const panel = container.querySelector(`[id="music-sound-search-content"]`);
            expect(panel?.classList.contains('hidden')).toBe(false);
            expect(panel?.textContent).toMatch(/No sonic matches/);
        });
    });

    // Regression: a client-side request timeout (apiFetch's own AbortController
    // firing with nothing superseding it) surfaces as status:0, same as an abort
    // caused by the user editing the query. Only the latter should be swallowed
    // silently — a genuine timeout with no successor in flight must show an
    // error, or the panel goes blank forever with the disclosure stuck "open"
    // and no feedback (reported as the "Sounds like… loads infinitely" bug).
    test('unsuperseded timeout (status 0) shows an error, not a silent blank panel', async () => {
        vi.mocked(searchMusicByText).mockResolvedValue({
            data: null,
            error: 'Request timed out',
            status: 0,
        });

        const { container, findByRole } = render(SemanticSearchSection, {
            props: defaultProps(),
        });
        const btn = container.querySelector('[data-testid="semantic-section-sound"]')!;
        await fireEvent.click(btn);

        const alert = await findByRole('alert');
        expect(alert).toBeTruthy();
        expect(alert.textContent).toMatch(/timed out/i);
    });

    // Fix 2: rapid collapse→re-expand while in-flight must not fire a second fetch.
    test('rapid collapse→re-expand while in-flight fires only ONE fetch', async () => {
        let resolveFirst!: (v: typeof fakeSuccessResult) => void;
        const firstFetch = new Promise<typeof fakeSuccessResult>((res) => {
            resolveFirst = res;
        });

        vi.mocked(searchMusicByText)
            .mockReturnValueOnce(firstFetch)
            .mockResolvedValue(fakeSuccessResult);

        const { container } = render(SemanticSearchSection, { props: defaultProps() });
        const btn = container.querySelector('[data-testid="semantic-section-sound"]')!;

        // Expand → first fetch fires but is still in-flight
        await fireEvent.click(btn);
        expect(vi.mocked(searchMusicByText)).toHaveBeenCalledTimes(1);

        // Collapse
        await fireEvent.click(btn);
        // Re-expand — in-flight guard must prevent a second fetch
        await fireEvent.click(btn);

        // Still only 1 fetch
        expect(vi.mocked(searchMusicByText)).toHaveBeenCalledTimes(1);

        // Clean up: let the first fetch resolve so no dangling promises
        resolveFirst(fakeSuccessResult);
    });
});
