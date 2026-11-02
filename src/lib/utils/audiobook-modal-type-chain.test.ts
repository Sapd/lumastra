// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * End-of-chain guard for the audiobook `mediaType` collapse.
 *
 * This test wires the REAL producer to the REAL consumer:
 *
 *   media_items row (media_type = 'audiobook')
 *     → transformToMediaDetail()            [server, api-transforms.ts]
 *     → MediaDetailSchema.parse()           [what defs/media/details.ts json()s]
 *     → handleItemClick()                   [client, foryou/item-handlers.ts]
 *     → openMediaModal({ mediaType })       [asserted here]
 *
 * Only the transport (`$lib/api/content`) and the modal sink
 * (`$lib/utils/modal-utils`) are mocked — every media-type derivation on the
 * path runs for real. That is deliberate: the two previous fixes for this bug
 * shipped guards whose INPUT was already collapsed, and a test that mocks the
 * server payload by hand would have passed for both of them.
 *
 * The home "Jump back in" rail reaches the EXTERNAL branch of
 * `handleItemClick` (not the local `/api/movie-details` one), because an
 * AudiobookShelf book has no `jellyfin` external id, no `jellyfinSeriesId` and
 * no `seriesId` — see `continueWatchingRowToItem` in
 * effective-watching.service.ts, which fills `jellyfin` from the row's
 * `jellyfin_id` (NULL for an ABS-sourced book).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transformToMediaDetail, type DbMediaRow } from '$lib/server/utils/api-transforms.js';
import { MediaDetailSchema } from '$lib/schemas/media-detail.js';
import { MovieDetailsResponseSchema } from '$lib/schemas/api-content-responses';
import { isAudiobook, isMovie } from '$lib/shared/media-types';
import { buildTitleSlug, slugKindForMediaType } from '$lib/utils/url-slugs';
import type { UniversalMediaItem, PageSection } from '$lib/types/server-driven-ui';

const AUDIOBOOK_UUID = '4993e963-4220-4f1e-adc0-fb475034149a';
const AUDIOBOOK_TITLE = 'Milo Farrow und der Stein der Weisen - Gesprochen von Felix Vale';

// --- mocks: transport + sinks only ------------------------------------------

const openMediaModal = vi.fn();
const getMediaDetailsByQuery = vi.fn();
const getMovieDetails = vi.fn();

vi.mock('$lib/utils/modal-utils', () => ({
    openMediaModal: (...args: unknown[]) => openMediaModal(...args),
    handleRequestAction: vi.fn(),
    openAlbumForTrack: vi.fn(),
}));

vi.mock('$lib/api/content', () => ({
    getMediaDetailsByQuery: (...args: unknown[]) => getMediaDetailsByQuery(...args),
    getMovieDetails: (...args: unknown[]) => getMovieDetails(...args),
    getSimilarMedia: vi.fn(),
}));

vi.mock('$lib/stores/modal.store', () => ({
    modals: { open: vi.fn(), replace: vi.fn(), close: vi.fn() },
}));

vi.mock('$lib/components/SimilarMoviesModal.svelte', () => ({ default: {} }));

vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { play: vi.fn() },
}));

vi.mock('$lib/stores/watch-navigation', () => ({
    navigateToWatch: vi.fn(),
}));

// --- fixtures ---------------------------------------------------------------

/**
 * The DB row shape `getMediaDetailByUuid` → `toDbMediaRow` hands to
 * `transformToMediaDetail` for an AudiobookShelf book.
 */
const audiobookRow: DbMediaRow = {
    media_id: AUDIOBOOK_UUID,
    media_type: 'audiobook',
    title: AUDIOBOOK_TITLE,
    overview: 'Ein Junge erfährt, dass er ein Zauberer ist.',
    year: 1999,
    is_available: true,
    can_request: false,
};

/**
 * The Continue-Watching card as `transformContinueWatching` emits it: correct
 * `mediaType`, internal UUID only, NO jellyfin id / seriesId.
 */
const cwAudiobookItem: UniversalMediaItem = {
    id: `cw:${AUDIOBOOK_UUID}`,
    externalIds: { internal: AUDIOBOOK_UUID },
    mediaType: 'audiobook',
    title: AUDIOBOOK_TITLE,
    image: `/api/media/${AUDIOBOOK_UUID}/images/poster?size=card`,
    isAvailable: true,
    canRequest: false,
} as UniversalMediaItem;

const cwSection = {
    id: 'continue-watching',
    type: 'continue-watching',
    title: 'Jump back in',
    items: [cwAudiobookItem],
} as unknown as PageSection;

/** Exactly what the route sends: transform → union parse → JSON. */
function serverPayloadFor(row: DbMediaRow): unknown {
    return JSON.parse(
        JSON.stringify(
            MediaDetailSchema.parse(
                transformToMediaDetail(row, {
                    internal: row.media_id,
                }),
            ),
        ),
    );
}

describe('audiobook CW card click → modal mediaType (whole chain)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('the payload the server actually sends already says "audiobook"', () => {
        const payload = serverPayloadFor(audiobookRow) as { type: string };
        expect(payload.type).toBe('audiobook');
    });

    it('openMediaModal receives mediaType "audiobook", not "movie"', async () => {
        getMediaDetailsByQuery.mockResolvedValue({
            data: serverPayloadFor(audiobookRow),
            error: null,
        });

        const { handleItemClick } = await import('$lib/components/foryou/item-handlers');
        await handleItemClick({ section: cwSection, item: cwAudiobookItem });

        // The EXTERNAL branch must have been the one taken.
        expect(getMovieDetails).not.toHaveBeenCalled();
        expect(getMediaDetailsByQuery).toHaveBeenCalledWith(AUDIOBOOK_UUID);

        expect(openMediaModal).toHaveBeenCalledTimes(1);
        const media = openMediaModal.mock.calls[0][0] as { mediaType: string };
        expect(media.mediaType).toBe('audiobook');
    });

    it('the value that reaches the modal drives the audiobook slug and the modal gates', async () => {
        getMediaDetailsByQuery.mockResolvedValue({
            data: serverPayloadFor(audiobookRow),
            error: null,
        });

        const { handleItemClick } = await import('$lib/components/foryou/item-handlers');
        await handleItemClick({ section: cwSection, item: cwAudiobookItem });
        const media = openMediaModal.mock.calls[0][0] as { mediaType: string };

        // openMediaModal upper-cases mediaType before it becomes modal props
        // (modal-utils.ts), and modal-url-sync/ModalActions/ModalMovie all read
        // that RAW prop. Assert through both case conventions so this stays true
        // regardless of which one the opener used — a bare `=== 'AUDIOBOOK'`
        // comparison anywhere on this chain is a latent bug.
        for (const candidate of [media.mediaType, media.mediaType.toUpperCase()]) {
            // ?slug=audiobook-… (modal-url-sync → slugKindForMediaType(rawMediaType))
            expect(slugKindForMediaType(candidate)).toBe('audiobook');
            // ModalMovie's isAudiobookItem → <ModalAudiobookDetails>;
            // ModalActions' Listen button + hidden mark-as-watched button.
            expect(isAudiobook(candidate)).toBe(true);
            // Must NOT read as a movie anywhere.
            expect(isMovie(candidate)).toBe(false);
        }

        expect(buildTitleSlug(slugKindForMediaType(media.mediaType), AUDIOBOOK_TITLE)).toBe(
            'audiobook-milo-farrow-und-der-stein-der-weisen-gesprochen-von-felix-vale',
        );
    });

    // -------------------------------------------------------------------------
    // LOCAL branch — GET /api/movie-details/{id}
    // -------------------------------------------------------------------------
    //
    // Taken when the CW item DOES carry a jellyfin id (an install where the
    // book also exists in Jellyfin, or any future CW row that fills one). Its
    // `type` came from toPublicMovieOrSeries(), the same movie|series clamp,
    // so this branch lied identically.
    it('the movie-details contract can carry an audiobook, and the local branch passes it through', async () => {
        // The REAL client-side mirror the app validates that response with.
        // A two-value enum throws here — that is the red assertion.
        const localPayload = MovieDetailsResponseSchema.parse({
            id: AUDIOBOOK_UUID,
            images: {},
            type: 'audiobook',
            ids: { internal: AUDIOBOOK_UUID },
            title: AUDIOBOOK_TITLE,
            genres: [],
            isAvailable: true,
            canRequest: false,
            playbackAvailable: true,
        });
        expect(localPayload.type).toBe('audiobook');

        getMovieDetails.mockResolvedValue({ data: localPayload, error: null });

        const { handleItemClick } = await import('$lib/components/foryou/item-handlers');
        await handleItemClick({
            section: cwSection,
            item: {
                ...cwAudiobookItem,
                externalIds: { internal: AUDIOBOOK_UUID },
                // The local branch is selected by a series context (it used to
                // be a Jellyfin id, which the API no longer sends).
                seriesId: 'series-context',
            } as UniversalMediaItem,
        });

        // The LOCAL branch must have been the one taken.
        expect(getMovieDetails).toHaveBeenCalledWith(AUDIOBOOK_UUID);
        expect(getMediaDetailsByQuery).not.toHaveBeenCalled();

        const media = openMediaModal.mock.calls[0][0] as { mediaType: string };
        expect(media.mediaType).toBe('audiobook');
    });

    it('a movie row on the same path is unaffected', async () => {
        getMediaDetailsByQuery.mockResolvedValue({
            data: serverPayloadFor({ ...audiobookRow, media_type: 'movie' }),
            error: null,
        });

        const { handleItemClick } = await import('$lib/components/foryou/item-handlers');
        await handleItemClick({
            section: cwSection,
            item: { ...cwAudiobookItem, mediaType: 'movie' } as UniversalMediaItem,
        });

        const media = openMediaModal.mock.calls[0][0] as { mediaType: string };
        expect(media.mediaType).toBe('movie');
    });
});
