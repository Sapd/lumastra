// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable, writable } from 'svelte/store';
import type { ExternalIds } from '$lib/types/api-common';
import type { RequestNotification } from '$lib/types/notifications';

const { getListeningSharing, updateListeningSharing, confirmDialog } = vi.hoisted(() => ({
    getListeningSharing: vi.fn(),
    updateListeningSharing: vi.fn(),
    confirmDialog: vi.fn(),
}));

// --- mocks: stores/runtime the footer reads ---
vi.mock('$app/stores', () => ({
    page: readable({ data: { features: { requests: true } }, url: new URL('http://localhost/') }),
}));
const trackedRequests = writable({ notifications: [] as RequestNotification[], lastPoll: 0 });
vi.mock('$lib/stores/request-notifications', () => ({
    requestNotifications: {
        subscribe: (run: Parameters<typeof trackedRequests.subscribe>[0]) =>
            trackedRequests.subscribe(run),
    },
}));
vi.mock('$lib/paraglide/runtime.js', () => ({
    getLocale: () => 'en',
    setLocale: vi.fn(),
    locales: ['en', 'de'],
    isLocale: (v: string) => v === 'en' || v === 'de',
    experimentalStaticLocale: null,
}));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_AUDIOBOOKURL: 'https://audio.example' } }));
vi.mock('$lib/stores/modal.store', () => ({
    modals: { replace: vi.fn(), closeAll: vi.fn() },
}));
vi.mock('$lib/stores/playerNavigation', () => ({
    saveReturnPath: vi.fn(),
    setNavigatingToPlayer: vi.fn(),
    clearNavigatingToPlayer: vi.fn(),
}));
vi.mock('$lib/utils/modal-utils', () => ({ openRequestModal: vi.fn(), confirmDialog }));
vi.mock('$lib/api/content.js', () => ({ getListeningSharing, updateListeningSharing }));

// --- mocks: heavy child components (unrelated to the branch chain under test) ---
vi.mock('$lib/components/ui', async () => ({
    WatchlistButton: (await import('./__fixtures__/WatchlistButtonProps.svelte')).default,
    SendToTVButton: vi.fn(),
    // Pass-through: the audiobook sharing toggle is wrapped in a Tooltip.
    Tooltip: (await import('./__fixtures__/TooltipPassthrough.svelte')).default,
}));
vi.mock('$lib/components/playlist', () => ({ PlaylistButton: vi.fn() }));
vi.mock('$lib/components/AIRatingButton.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/SeasonSelectorModal.svelte', () => ({ default: vi.fn() }));
vi.mock('./DebugPanel.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/ui/ContextMenu.svelte', () => ({ default: vi.fn() }));

vi.mock('$lib/pwa', () => ({ isPWAInstalled: vi.fn(() => false) }));

import { isPWAInstalled } from '$lib/pwa';
import ModalActions from './ModalActions.svelte';
import { env } from '$env/dynamic/public';

// Name kept from when these ids also carried a Jellyfin id (the API no longer
// sends one); the internal UUID is what every branch below keys on.
const withJellyfin: ExternalIds = {
    internal: 'a3f5e8c7-1234-5678-90ab-cdef12345678',
};

describe('ModalActions play/request branch chain (H23) — exactly one branch renders', () => {
    afterEach(() => {
        cleanup();
        env.PUBLIC_AUDIOBOOKURL = 'https://audio.example';
        getListeningSharing.mockReset();
        updateListeningSharing.mockReset();
        confirmDialog.mockReset();
    });

    test('audiobook branch: Listen link renders, no Watch/Request/unavailable markers', () => {
        render(ModalActions, { mediaType: 'audiobook', externalIds: withJellyfin });
        expect(screen.getByText('Listen')).toBeTruthy();
        expect(screen.queryByText(/not available yet/i)).toBeNull();
        expect(screen.queryByRole('link', { name: /Watch/ })).toBeNull();
        expect(screen.queryByText('Request')).toBeNull();
    });

    test.each(['https://proxy/audiobookshelf', 'https://proxy/audiobookshelf/'])(
        'public ABS item link keeps the configured base %s exactly once',
        (base) => {
            env.PUBLIC_AUDIOBOOKURL = base;
            render(ModalActions, {
                mediaType: 'audiobook',
                externalIds: { ...withJellyfin, audiobookshelf: 'book-id' },
            });
            expect(screen.getByRole('link', { name: 'AudiobookShelf' }).getAttribute('href')).toBe(
                'https://proxy/audiobookshelf/item/book-id',
            );
            env.PUBLIC_AUDIOBOOKURL = 'https://audio.example';
        },
    );

    test.each(['abs.local', 'abs.local:13378'])(
        'invalid PUBLIC_AUDIOBOOKURL %s hides the external link without breaking Listen',
        (base) => {
            env.PUBLIC_AUDIOBOOKURL = base;
            render(ModalActions, {
                mediaType: 'audiobook',
                externalIds: { ...withJellyfin, audiobookshelf: 'book-id' },
            });
            expect(screen.getByTestId('audiobook-listen')).toBeTruthy();
            expect(screen.queryByRole('link', { name: 'AudiobookShelf' })).toBeNull();
        },
    );

    test.each([
        ['https://audio.example', 'https://audio.example/audiobookshelf/item/book-id'],
        ['https://audio.example/', 'https://audio.example/audiobookshelf/item/book-id'],
        [
            'https://audio.example/?tenant=books',
            'https://audio.example/audiobookshelf/item/book-id?tenant=books',
        ],
        [
            'https://audio.example/custom/?tenant=books',
            'https://audio.example/custom/item/book-id?tenant=books',
        ],
        ['/audiobookshelf/', '/audiobookshelf/item/book-id'],
        ['/', '/audiobookshelf/item/book-id'],
    ])('keeps the compatible public ABS item link for %s', (base, expected) => {
        env.PUBLIC_AUDIOBOOKURL = base;
        render(ModalActions, {
            mediaType: 'audiobook',
            externalIds: { ...withJellyfin, audiobookshelf: 'book-id' },
        });
        expect(screen.getByRole('link', { name: 'AudiobookShelf' }).getAttribute('href')).toBe(
            expected,
        );
    });

    test('audiobook Listen is disabled when availability is explicitly false', () => {
        render(ModalActions, {
            mediaType: 'audiobook',
            externalIds: withJellyfin,
            isAvailable: false,
        });
        expect((screen.getByTestId('audiobook-listen') as HTMLButtonElement).disabled).toBe(true);
    });

    test.each([
        { isAvailable: false, expected: 'false' },
        { isAvailable: true, expected: 'true' },
    ])(
        'watchlist receives availability=$expected for a valid catalog UUID',
        ({ isAvailable, expected }) => {
            render(ModalActions, {
                mediaType: 'movie',
                externalIds: withJellyfin,
                isAvailable,
            });

            expect(screen.getByTestId('watchlist-button').getAttribute('data-available')).toBe(
                expected,
            );
        },
    );

    test('audiobook branch: the user can make one book private', async () => {
        getListeningSharing.mockResolvedValue({
            error: null,
            data: { shared: true, globallyShared: true, effectiveShared: true },
        });
        updateListeningSharing.mockResolvedValue({
            error: null,
            data: { shared: false, globallyShared: true, effectiveShared: false },
        });

        render(ModalActions, { mediaType: 'audiobook', externalIds: withJellyfin });
        const toggle = await screen.findByRole('button', {
            name: /Others can see your progress in this book/i,
        });
        await fireEvent.click(toggle);

        await waitFor(() => {
            expect(updateListeningSharing).toHaveBeenCalledWith(withJellyfin.internal, false);
        });
        expect(
            screen.getByRole('button', {
                name: /Your progress in this book is hidden from others/i,
            }),
        ).toBeTruthy();
    });

    test('audiobook branch: the per-book control is inert when global sharing is off', async () => {
        getListeningSharing.mockResolvedValue({
            error: null,
            data: { shared: true, globallyShared: false, effectiveShared: false },
        });

        render(ModalActions, { mediaType: 'audiobook', externalIds: withJellyfin });
        const toggle = await screen.findByRole('button', { name: /Audiobook sharing is off/i });
        // aria-disabled, not disabled, so the explaining tooltip still shows on hover.
        expect(toggle.getAttribute('aria-disabled')).toBe('true');
        await fireEvent.click(toggle);
        expect(updateListeningSharing).not.toHaveBeenCalled();
    });

    test('audiobook branch: mark as finished asks first, then marks', async () => {
        getListeningSharing.mockResolvedValue({ error: 'n/a', data: null });
        confirmDialog.mockResolvedValue(undefined);
        const onaudiobookfinished = vi.fn(async () => {});

        render(ModalActions, {
            mediaType: 'audiobook',
            externalIds: withJellyfin,
            title: 'Die Laternenbowle',
            onaudiobookfinished,
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Mark as finished' }));

        await waitFor(() => expect(onaudiobookfinished).toHaveBeenCalledTimes(1));
        expect(confirmDialog).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.stringContaining('Die Laternenbowle'),
            }),
        );
    });

    test('audiobook branch: cancelling the confirmation marks nothing', async () => {
        getListeningSharing.mockResolvedValue({ error: 'n/a', data: null });
        confirmDialog.mockRejectedValue(undefined);
        const onaudiobookfinished = vi.fn(async () => {});

        render(ModalActions, {
            mediaType: 'audiobook',
            externalIds: withJellyfin,
            onaudiobookfinished,
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Mark as finished' }));

        await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
        expect(onaudiobookfinished).not.toHaveBeenCalled();
    });

    test('audiobook branch: no mark-as-finished once the book is finished', () => {
        render(ModalActions, {
            mediaType: 'audiobook',
            externalIds: withJellyfin,
            audiobookFinished: true,
            onaudiobookfinished: vi.fn(async () => {}),
        });
        expect(screen.queryByRole('button', { name: 'Mark as finished' })).toBeNull();
    });

    test('episode & !isAvailable branch: "not available yet" renders, no Watch/Listen/Request', () => {
        render(ModalActions, {
            mediaType: 'episode',
            isAvailable: false,
            externalIds: withJellyfin,
            seasonNumber: 2,
            episodeNumber: 5,
        });
        expect(screen.getByText(/not available yet/i)).toBeTruthy();
        expect(screen.queryByText('Listen')).toBeNull();
        expect(screen.queryByRole('link', { name: /Watch/ })).toBeNull();
        expect(screen.queryByText('Request')).toBeNull();
    });

    test('playableId & canPlayDirectly branch (movie, available): Watch link renders', () => {
        render(ModalActions, {
            mediaType: 'movie',
            isAvailable: true,
            isSeries: false,
            externalIds: withJellyfin,
            title: 'A Movie',
        });
        const link = screen.getByRole('link', { name: /Watch A Movie/ });
        expect(link).toBeTruthy();
        // mediaKey is the internal UUID (UUID-first pattern).
        expect(link.getAttribute('href')).toBe(`/watch/${withJellyfin.internal}`);
        expect(screen.queryByText(/not available yet/i)).toBeNull();
        expect(screen.queryByText('Listen')).toBeNull();
        expect(screen.queryByText('Request')).toBeNull();
    });

    test('playableId & !isSeries(prop) & isAvailable but !canPlayDirectly branch: fallthrough when mediaType string says series but isSeries prop is false', () => {
        // mediaType='tv' makes canPlayDirectly() return false (series can't play directly),
        // but the `isSeries` PROP is explicitly false here — a mismatch between the derived
        // mediaType-string check and the component's own isSeries prop. This is the
        // fallthrough case documented for branch 4.
        render(ModalActions, {
            mediaType: 'tv',
            isAvailable: true,
            isSeries: false,
            externalIds: withJellyfin,
            title: 'Mismatch',
        });
        const link = screen.getByRole('link', { name: /Watch/ });
        expect(link).toBeTruthy();
        expect(link.getAttribute('href')).toBe(`/watch/${withJellyfin.internal}`);
        expect(screen.queryByText(/not available yet/i)).toBeNull();
        expect(screen.queryByText('Request')).toBeNull();
    });

    test('playableId & isSeries branch: series Watch link renders (see H24 for fallthrough detail)', () => {
        render(ModalActions, {
            mediaType: 'tv',
            isAvailable: true,
            isSeries: true,
            externalIds: withJellyfin,
            title: 'A Series',
        });
        const link = screen.getByRole('link', { name: /Watch/ });
        expect(link).toBeTruthy();
        expect(screen.queryByText(/not available yet/i)).toBeNull();
        expect(screen.queryByText('Request')).toBeNull();
    });

    test('sonarrHasFile branch: "file not available" text renders, no Watch/Request', () => {
        render(ModalActions, {
            mediaType: 'movie',
            isAvailable: false,
            sonarrHasFile: true,
            externalIds: undefined,
        });
        expect(screen.getByText(/exists but not yet available/i)).toBeTruthy();
        expect(screen.queryByRole('link', { name: /Watch/ })).toBeNull();
        expect(screen.queryByText('Request')).toBeNull();
    });

    test('canRequest & hasValidExternalIds branch: Request control renders, no Watch/unavailable', () => {
        render(ModalActions, {
            mediaType: 'movie',
            isAvailable: false,
            sonarrHasFile: false,
            canRequest: true,
            externalIds: { tmdb: '550' },
        });
        expect(screen.getByText('Request')).toBeTruthy();
        expect(screen.queryByRole('link', { name: /Watch/ })).toBeNull();
        expect(screen.queryByText(/file not available/i)).toBeNull();
    });
});

describe('ModalActions series Watch href fallthrough (H24)', () => {
    afterEach(() => cleanup());

    test.each([true, false])(
        'unavailable catalog series with UUID never offers Watch (requestable=%s)',
        (requestable) => {
            render(ModalActions, {
                mediaType: 'tv',
                isSeries: true,
                isAvailable: false,
                canRequest: requestable,
                externalIds: withJellyfin,
                title: 'Catalog series',
            });
            expect(screen.queryByRole('link', { name: /Watch/ })).toBeNull();
            expect(screen.queryByRole('button', { name: /Watch/ })).toBeNull();
            if (requestable) expect(screen.getByText('Request')).toBeTruthy();
        },
    );

    test.each([true, false])(
        'rerendering available=%s to its opposite updates series playback and request actions',
        async (initiallyAvailable) => {
            const props = {
                mediaType: 'tv',
                isSeries: true,
                externalIds: withJellyfin,
                title: 'A Series',
                nextEpisodeId: 'next-ep-uuid',
                nextEpisode: { seasonNumber: 3, episodeNumber: 1, playable: true },
                nextEpisodeLoading: false,
            };
            const { rerender } = render(ModalActions, {
                ...props,
                isAvailable: initiallyAvailable,
                canRequest: !initiallyAvailable,
            });
            if (initiallyAvailable) {
                expect(screen.getByRole('link', { name: /Watch S3 E1/ }).getAttribute('href')).toBe(
                    '/watch/next-ep-uuid?entry=next_up',
                );
                expect(screen.queryByText('Request')).toBeNull();
            } else {
                expect(screen.queryByRole('link', { name: /Watch/ })).toBeNull();
                expect(screen.queryByRole('button', { name: /Watch/ })).toBeNull();
                expect(screen.getByText('Request')).toBeTruthy();
            }

            await rerender({
                ...props,
                isAvailable: !initiallyAvailable,
                canRequest: initiallyAvailable,
            });
            if (initiallyAvailable) {
                expect(screen.queryByRole('link', { name: /Watch/ })).toBeNull();
                expect(screen.queryByRole('button', { name: /Watch/ })).toBeNull();
                expect(screen.getByText('Request')).toBeTruthy();
            } else {
                expect(screen.getByRole('link', { name: /Watch S3 E1/ }).getAttribute('href')).toBe(
                    '/watch/next-ep-uuid?entry=next_up',
                );
                expect(screen.queryByText('Request')).toBeNull();
            }
        },
    );

    test.each([false, true])(
        'unavailable series ignores stale next-episode state (loading=%s)',
        (nextEpisodeLoading) => {
            render(ModalActions, {
                mediaType: 'tv',
                isSeries: true,
                isAvailable: false,
                canRequest: true,
                externalIds: withJellyfin,
                title: 'Catalog series',
                nextEpisodeId: 'stale-next-ep-uuid',
                nextEpisode: { seasonNumber: 3, episodeNumber: 1, playable: true },
                nextEpisodeLoading,
            });
            expect(screen.queryByRole('link', { name: /Watch/ })).toBeNull();
            expect(screen.queryByRole('button', { name: /Watch/ })).toBeNull();
            expect(screen.getByText('Request')).toBeTruthy();
        },
    );

    test('isSeries=true, playableId set, no nextEpisode loaded → href resolves to SERIES playableId/mediaKey', () => {
        render(ModalActions, {
            mediaType: 'tv',
            isAvailable: true,
            isSeries: true,
            nextEpisodeId: null,
            nextEpisodeLoading: false,
            externalIds: withJellyfin,
            title: 'A Series',
        });
        const link = screen.getByRole('link', { name: /Watch/ });
        // No nextEpisodeId → falls through to the series-level watch URL, keyed by
        // the series' own playableId/mediaKey (not an episode key).
        expect(link.getAttribute('href')).toBe(`/watch/${withJellyfin.internal}`);
    });

    test('isSeries=true, nextEpisodeId set → href uses nextEpisodeId', () => {
        render(ModalActions, {
            mediaType: 'tv',
            isAvailable: true,
            isSeries: true,
            nextEpisodeId: 'next-ep-uuid',
            nextEpisode: { seasonNumber: 3, episodeNumber: 1 },
            nextEpisodeLoading: false,
            externalIds: withJellyfin,
            title: 'A Series',
        });
        const link = screen.getByRole('link', { name: /Watch S3 E1/ });
        expect(link.getAttribute('href')).toBe('/watch/next-ep-uuid?entry=next_up');
    });

    test('targeted episode without a file → disabled "Watch S6 E3", no link to any episode', () => {
        render(ModalActions, {
            mediaType: 'tv',
            isAvailable: true,
            isSeries: true,
            nextEpisodeId: 'unaired-ep-uuid',
            nextEpisode: { seasonNumber: 6, episodeNumber: 3, playable: false },
            nextEpisodeLoading: false,
            externalIds: withJellyfin,
            title: 'A Series',
        });
        const button = screen.getByRole('button', { name: /Watch S6 E3/ });
        expect((button as HTMLButtonElement).disabled).toBe(true);
        expect(screen.queryByRole('link', { name: /Watch/ })).toBeNull();
    });
});

describe('ModalActions canRequest gate (M25) — hasValidExternalIds is any non-empty object', () => {
    afterEach(() => cleanup());

    test('current behavior: canRequest=true with externalIds={internal} (no requestable provider) still shows Request', () => {
        // hasValidExternalIds = externalIds && Object.keys(externalIds).length > 0 — this
        // passes for ANY non-empty externalIds object, even one with only an internal UUID
        // and no TMDB/IMDB/etc. provider id. This differs from hasValidExternalId(), which
        // requires an actual provider id. Documenting current behavior only.
        render(ModalActions, {
            mediaType: 'movie',
            isAvailable: false,
            sonarrHasFile: false,
            canRequest: true,
            externalIds: { internal: 'a3f5e8c7-1234-5678-90ab-cdef12345678' },
        });
        expect(screen.getByText('Request')).toBeTruthy();
    });

    test('valid tmdb externalIds → Request also shows', () => {
        render(ModalActions, {
            mediaType: 'movie',
            isAvailable: false,
            sonarrHasFile: false,
            canRequest: true,
            externalIds: { tmdb: '550' },
        });
        expect(screen.getByText('Request')).toBeTruthy();
    });
});

describe('ModalActions Watched button label/scope (M26)', () => {
    afterEach(() => cleanup());

    test('movie: scope label "Mark Movie as Watched", aria-pressed reflects isWatched (toggle mode)', () => {
        render(ModalActions, {
            mediaType: 'movie',
            isAvailable: true,
            isWatched: false,
            externalIds: withJellyfin,
        });
        const button = screen.getByRole('button', { name: /Mark Movie as Watched/i });
        expect(button.getAttribute('aria-pressed')).toBe('false');
    });

    test('movie watched: title/aria-label is action-oriented ("Mark Movie as unwatched"), visible label is state-oriented ("Movie watched"), aria-pressed=true', () => {
        render(ModalActions, {
            mediaType: 'movie',
            isAvailable: true,
            isWatched: true,
            externalIds: withJellyfin,
        });
        const button = screen.getByRole('button', { name: /Mark Movie as unwatched/i });
        expect(button.getAttribute('title')).toMatch(/Mark Movie as unwatched/i);
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.textContent).toMatch(/Movie watched/i);
    });

    test('series without nextEpisode: scope-aware series label, toggle mode (aria-pressed present)', () => {
        render(ModalActions, {
            mediaType: 'tv',
            isSeries: true,
            isAvailable: true,
            isWatched: false,
            nextEpisode: null,
            nextEpisodeId: null,
            externalIds: withJellyfin,
        });
        const button = screen.getByRole('button', { name: /Mark Series as Watched/i });
        expect(button.getAttribute('aria-pressed')).toBe('false');
    });

    test('series with nextEpisode: action-mode label "Mark S{n}E{n} as watched", aria-pressed omitted', () => {
        render(ModalActions, {
            mediaType: 'tv',
            isSeries: true,
            isAvailable: true,
            isWatched: false,
            nextEpisode: { seasonNumber: 4, episodeNumber: 2 },
            nextEpisodeId: 'next-ep-uuid',
            externalIds: withJellyfin,
        });
        const button = screen.getByRole('button', { name: /Mark S4E2 as watched/i });
        expect(button.getAttribute('aria-pressed')).toBeNull();
    });

    test('episode with S/E props: scope label includes season/episode', () => {
        render(ModalActions, {
            mediaType: 'episode',
            isAvailable: true,
            isWatched: false,
            seasonNumber: 1,
            episodeNumber: 3,
            externalIds: withJellyfin,
        });
        const button = screen.getByRole('button', { name: /Mark S1E3 as watched/i });
        expect(button.getAttribute('aria-pressed')).toBe('false');
    });

    test('episode without S/E props: generic episode scope label', () => {
        render(ModalActions, {
            mediaType: 'episode',
            isAvailable: true,
            isWatched: false,
            externalIds: withJellyfin,
        });
        const button = screen.getByRole('button', { name: /Mark Episode as Watched/i });
        expect(button.getAttribute('aria-pressed')).toBe('false');
    });

    test('justMarkedEpisode: undo label overrides scope label, aria-pressed omitted (action mode)', () => {
        render(ModalActions, {
            mediaType: 'tv',
            isSeries: true,
            isAvailable: true,
            isWatched: false,
            justMarkedEpisode: { seasonNumber: 5, episodeNumber: 9 },
            externalIds: withJellyfin,
        });
        const button = screen.getByRole('button', { name: /S5E9 watched.*undo/i });
        expect(button.getAttribute('aria-pressed')).toBeNull();
    });
});

/**
 * Share button. Same reasoning as the player's: an installed PWA has no
 * address bar, so the link to a title is otherwise unreachable. It hands
 * over the `?modal=` deep link the card context menu already copies, so a
 * recipient lands on this same detail modal.
 *
 * Only `$lib/pwa` and the platform share sheet are stubbed — the URL
 * asserted here is the one a recipient would really receive.
 */
describe('ModalActions share button (PWA only)', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.mocked(isPWAInstalled).mockReturnValue(false);
    });

    test('stays hidden in a normal browser tab', () => {
        vi.mocked(isPWAInstalled).mockReturnValue(false);

        render(ModalActions, { mediaType: 'movie', externalIds: withJellyfin, title: 'Awakening' });

        expect(screen.queryByRole('button', { name: /Share a link to this title/i })).toBeNull();
    });

    test('shares the modal deep link when installed as a PWA', async () => {
        vi.mocked(isPWAInstalled).mockReturnValue(true);
        const share = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { share, clipboard: { writeText: vi.fn() } });

        render(ModalActions, { mediaType: 'movie', externalIds: withJellyfin, title: 'Awakening' });
        await fireEvent.click(screen.getByRole('button', { name: /Share a link to this title/i }));

        expect(share).toHaveBeenCalledOnce();
        const { title, url } = share.mock.calls[0][0] as { title: string; url: string };
        expect(title).toBe('Awakening');
        expect(new URL(url).searchParams.get('modal')).toBe(withJellyfin.internal);
    });

    test('has nothing to share without an id to build a link from', () => {
        vi.mocked(isPWAInstalled).mockReturnValue(true);

        render(ModalActions, { mediaType: 'movie', externalIds: {}, title: 'Awakening' });

        expect(screen.queryByRole('button', { name: /Share a link to this title/i })).toBeNull();
    });
});

describe('movie request lifecycle in the detail dialog', () => {
    afterEach(() => {
        cleanup();
        trackedRequests.set({ notifications: [], lastPoll: 0 });
    });

    test('replaces Request with live status, then Watch now when available', async () => {
        render(ModalActions, {
            mediaType: 'movie',
            canRequest: true,
            externalIds: { tmdb: '961' },
        });
        expect(screen.getByRole('button', { name: 'Request' })).toBeTruthy();
        const request: RequestNotification = {
            id: 'tmdb:961:movie',
            externalIds: { tmdb: '961' },
            mediaType: 'movie',
            title: 'The General',
            status: 'downloading',
            createdAt: Date.now(),
        };
        trackedRequests.set({ notifications: [request], lastPoll: 0 });
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Request' })).toBeNull());
        // Neutral wording (App Review 5.2.3): a server-side `downloading` status
        // reads as "In progress", never as a download.
        expect(screen.getByRole('status').textContent).toMatch(/In progress/i);
        expect(screen.getByRole('status').textContent).not.toMatch(/download/i);

        trackedRequests.set({ notifications: [{ ...request, status: 'available' }], lastPoll: 0 });
        await waitFor(() =>
            expect(screen.getByRole('link', { name: 'Watch now' }).getAttribute('href')).toBe(
                '/watch/tmdb:961:movie',
            ),
        );

        trackedRequests.set({
            notifications: [{ ...request, status: 'unavailable' }],
            lastPoll: 0,
        });
        await waitFor(() => expect(screen.getByRole('button', { name: 'Request' })).toBeTruthy());
    });

    test('does not hide a movie request because a series has the same provider id', () => {
        trackedRequests.set({
            notifications: [
                {
                    id: 'tmdb:961:series',
                    externalIds: { tmdb: '961' },
                    mediaType: 'series',
                    title: 'Series',
                    status: 'downloading',
                    createdAt: Date.now(),
                },
            ],
            lastPoll: 0,
        });
        render(ModalActions, {
            mediaType: 'movie',
            canRequest: true,
            externalIds: { tmdb: '961' },
        });
        expect(screen.getByRole('button', { name: 'Request' })).toBeTruthy();
    });
});
