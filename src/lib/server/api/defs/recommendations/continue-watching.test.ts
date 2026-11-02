// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * overlayContinueWatchingItems — per-user metadata-language overlay wiring.
 *
 * Final-review IMPORTANT finding (multilingual-media-metadata): /continue-watching
 * already resolves `accessCtx.langs` via `buildAccessContext` but never applied
 * the translation overlay to its items, so a non-primary-language user always
 * saw primary-language titles on this rail. These tests cover the extracted
 * `overlayContinueWatchingItems` helper directly (the route handler calls it
 * after building `items` from `watchManager.getContinueWatching`, which is not
 * cached — the items array is always freshly built, so overlaying in place is
 * safe with no clone needed).
 */

vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApplyOverlay, mockGetContinueWatchingPage, mockBuildAccessContext } = vi.hoisted(
    () => ({
        mockApplyOverlay: vi.fn().mockResolvedValue(undefined),
        mockGetContinueWatchingPage: vi.fn(),
        mockBuildAccessContext: vi.fn(),
    }),
);

vi.mock('$lib/server/utils/translation-overlay.js', () => ({
    applyTranslationOverlay: mockApplyOverlay,
}));

// Handler-level tests below drive `def.handlers.GET` directly (the ?types=
// allow-list must be proven on the REAL handler, since the whole point is where
// the filter sits relative to the pagination slice). Only the two runtime
// dependencies the handler reaches for are stubbed: the access context and the
// row source.
vi.mock('./continue-watching-page.query.js', () => ({
    getExactContinueWatchingPage: mockGetContinueWatchingPage,
}));

vi.mock('./recommender.js', () => ({
    buildAccessContext: mockBuildAccessContext,
}));

import {
    CW_AUDIOBOOK_STALE_AFTER_DAYS,
    CW_MIN_PROGRESS_PCT,
    CW_STALE_AFTER_DAYS,
    def,
    filterContinueWatchingByType,
    filterStaleContinueWatching,
    filterStaleWatchingItems,
    orderByLastActivity,
    overlayContinueWatchingItems,
    parseMediaTypeFilter,
    rowToItem,
    shouldDropFromContinueWatching,
    toContinueWatchingDatabaseTypes,
} from './continue-watching.js';
import type { RecommendationItem } from './recommender.js';
import type { ContinueWatchingRow } from '$lib/server/database/queries/watch-state.queries.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import type { ContinueWatchingItem } from '$lib/server/utils/section-builder.js';
import type { RequestEvent } from '@sveltejs/kit';

function cwRow(over: Partial<ContinueWatchingRow>): ContinueWatchingRow {
    return {
        media_id: 'uuid-1',
        media_type: 'movie',
        title: 'Test',
        tmdb_id: null,
        runtime_ms: null,
        resume_position_ms: null,
        ...over,
    } as ContinueWatchingRow;
}

/**
 * `rowToItem` + assert the row was publishable. It returns null for a row whose
 * stored `media_type` has no public representation (see its own describe block);
 * every other test here uses a movie/episode row, so a null there is a genuine
 * failure rather than something each assertion should have to re-narrow.
 */
function itemFor(row: ContinueWatchingRow, surface: ApiSurface): RecommendationItem {
    const mapped = rowToItem(row, surface);
    if (mapped === null) {
        throw new Error(`rowToItem unexpectedly dropped a '${row.media_type}' row`);
    }
    return mapped;
}

function item(id: string, title: string): RecommendationItem {
    return {
        media: { id, type: 'movie', title, ids: {} },
        reason: { kind: 'continue-watching' },
    };
}

describe('overlayContinueWatchingItems', () => {
    beforeEach(() => {
        mockApplyOverlay.mockClear();
    });

    it('no-ops when langs is undefined', async () => {
        await overlayContinueWatchingItems({} as never, [item('id-1', 'Old')], undefined);
        expect(mockApplyOverlay).not.toHaveBeenCalled();
    });

    it('no-ops when langs has neither titleLang nor textLang', async () => {
        await overlayContinueWatchingItems({} as never, [item('id-1', 'Old')], {
            titleLang: null,
            textLang: null,
        });
        expect(mockApplyOverlay).not.toHaveBeenCalled();
    });

    it('no-ops when items is empty', async () => {
        await overlayContinueWatchingItems({} as never, [], { titleLang: 'de', textLang: null });
        expect(mockApplyOverlay).not.toHaveBeenCalled();
    });

    it('runs two passes: item title (media.id) and series name (media.seriesId)', async () => {
        const items = [item('media-uuid-1', 'Old Title')];
        items[0].media.seriesId = 'series-uuid-1';
        items[0].media.seriesName = 'Old Series';
        await overlayContinueWatchingItems({} as never, items, {
            titleLang: 'de',
            textLang: null,
        });

        expect(mockApplyOverlay).toHaveBeenCalledTimes(2);

        // Pass 1 — localize the item's own title, keyed by media.id.
        const [sqlArg, passedItems, langs, titleOpts] = mockApplyOverlay.mock.calls[0];
        expect(sqlArg).toEqual({});
        expect(passedItems).toBe(items);
        expect(langs).toEqual({ titleLang: 'de', textLang: null });
        expect(titleOpts.id(items[0])).toBe('media-uuid-1');
        titleOpts.setTitle(items[0], 'Alter Titel');
        expect(items[0].media.title).toBe('Alter Titel');

        // Pass 2 — localize the series name, keyed by media.seriesId.
        const seriesOpts = mockApplyOverlay.mock.calls[1][3];
        expect(seriesOpts.id(items[0])).toBe('series-uuid-1');
        seriesOpts.setTitle(items[0], 'Alte Serie');
        expect(items[0].media.seriesName).toBe('Alte Serie');
    });

    it('series-name pass id accessor returns null for a non-episode item (no seriesId)', async () => {
        const items = [item('media-uuid-1', 'A Movie')];
        await overlayContinueWatchingItems({} as never, items, {
            titleLang: 'de',
            textLang: null,
        });
        // Second pass = series-name overlay; a movie has no seriesId → null (untouched).
        const seriesOpts = mockApplyOverlay.mock.calls[1][3];
        expect(seriesOpts.id(items[0])).toBeNull();
    });

    it('title pass id accessor returns null for an item with no media id', async () => {
        const items = [item('', 'Old')];
        await overlayContinueWatchingItems({} as never, items, {
            titleLang: 'de',
            textLang: null,
        });
        const titleOpts = mockApplyOverlay.mock.calls[0][3];
        expect(titleOpts.id(items[0])).toBeNull();
    });
});

describe('rowToItem — playback progress', () => {
    it('keeps explicit millisecond units', () => {
        // 1h40m runtime, 34m20s in.
        const it = itemFor(
            cwRow({ runtime_ms: 6_000_000, resume_position_ms: 2_060_000 }),
            'internal',
        );
        expect(it.progress?.durationMs).toBe(6000000);
        expect(it.progress?.positionMs).toBe(2060000);
    });

    it('uses null durationMs when runtime is unknown, still emits positionMs', () => {
        const it = itemFor(cwRow({ runtime_ms: null, resume_position_ms: 90_000 }), 'internal');
        expect(it.progress?.durationMs).toBeNull();
        expect(it.progress?.positionMs).toBe(90000);
    });

    it('clamps positionMs to durationMs so "duration - position" never goes negative', () => {
        // Position overshoots runtime (e.g. loosened upstream invariant / bad data).
        const it = itemFor(cwRow({ runtime_ms: 100_000, resume_position_ms: 120_000 }), 'internal');
        expect(it.progress?.durationMs).toBe(100000);
        expect(it.progress?.positionMs).toBe(100000);
    });

    it('treats a missing resume position as 0s', () => {
        const it = itemFor(
            cwRow({ runtime_ms: 100_000, resume_position_ms: undefined }),
            'internal',
        );
        expect(it.progress?.positionMs).toBe(0);
    });
});

describe('orderByLastActivity', () => {
    it('orders rows most-recent-activity first (matches web Home)', () => {
        const rows = [
            cwRow({ media_id: 'a', last_event_at: '2026-07-20T00:00:00.000Z' }),
            cwRow({ media_id: 'b', last_event_at: '2026-07-22T00:00:00.000Z' }),
            cwRow({ media_id: 'c', last_event_at: '2026-07-21T00:00:00.000Z' }),
        ];
        const out = orderByLastActivity(rows);
        expect(out.map((r) => r.media_id)).toEqual(['b', 'c', 'a']);
    });

    it('places rows with no timestamp last, with a deterministic media_id tiebreak', () => {
        const rows = [
            cwRow({ media_id: 'z', last_event_at: undefined as unknown as string }),
            cwRow({ media_id: 'a', last_event_at: undefined as unknown as string }),
            cwRow({ media_id: 'm', last_event_at: '2026-07-21T00:00:00.000Z' }),
        ];
        const out = orderByLastActivity(rows);
        expect(out.map((r) => r.media_id)).toEqual(['m', 'a', 'z']);
    });

    it('does not mutate the input array', () => {
        const rows = [
            cwRow({ media_id: 'a', last_event_at: '2026-07-20T00:00:00.000Z' }),
            cwRow({ media_id: 'b', last_event_at: '2026-07-22T00:00:00.000Z' }),
        ];
        const before = rows.map((r) => r.media_id);
        orderByLastActivity(rows);
        expect(rows.map((r) => r.media_id)).toEqual(before);
    });
});

describe('rowToItem — poster href follows the mounted surface', () => {
    it('prefixes the entity-image URL with /api on the internal surface', () => {
        const it = itemFor(cwRow({ media_id: 'media-uuid-9' }), 'internal');
        expect(it.media.images?.poster?.href).toBe(
            '/api/media/media-uuid-9/images/poster?size=thumb',
        );
    });

    it('prefixes the entity-image URL with /api/v1 on the v1 surface', () => {
        // The old `/api/image/catalog/...` form has no v1 route — v1 clients 404'd.
        const it = itemFor(cwRow({ media_id: 'media-uuid-9' }), 'v1');
        expect(it.media.images?.poster?.href).toBe(
            '/api/v1/media/media-uuid-9/images/poster?size=thumb',
        );
    });
});

describe('rowToItem — lastPlayedAt', () => {
    it('emits last_event_at as lastPlayedAt (ISO timestamp for recency sort + "paused ago" labels)', () => {
        const it = itemFor(cwRow({ last_event_at: '2026-07-21T10:00:00.000Z' }), 'internal');
        expect(it.progress?.updatedAt).toBe('2026-07-21T10:00:00.000Z');
    });

    it('omits lastPlayedAt when last_event_at is absent', () => {
        const it = itemFor(cwRow({ last_event_at: undefined as unknown as string }), 'internal');
        expect(it.progress?.updatedAt).toBeNull();
    });
});

describe('rowToItem — episode series context', () => {
    it('projects seriesId/seriesName/seasonNumber/episodeNumber for episodes', () => {
        const it = itemFor(
            cwRow({
                media_type: 'episode',
                title: 'Pilot',
                series_id: 'series-uuid-1',
                series_name: 'Drifting Clouds',
                season_number: 1,
                episode_number: 1,
            }),
            'internal',
        );
        expect(it.media.type).toBe('episode');
        expect(it.media.seriesId).toBe('series-uuid-1');
        expect(it.media.seriesName).toBe('Drifting Clouds');
        expect(it.media.seasonNumber).toBe(1);
        expect(it.media.episodeNumber).toBe(1);
    });

    it('emits season/episode 0 (specials) rather than dropping them', () => {
        const it = itemFor(
            cwRow({
                media_type: 'episode',
                title: 'Special',
                series_id: 'series-uuid-2',
                series_name: 'Some Show',
                season_number: 0,
                episode_number: 0,
            }),
            'internal',
        );
        expect(it.media.seasonNumber).toBe(0);
        expect(it.media.episodeNumber).toBe(0);
    });

    it('omits episode fields entirely for movies', () => {
        const it = itemFor(cwRow({ media_type: 'movie', title: 'A Movie' }), 'internal');
        expect(it.media.type).toBe('movie');
        expect(it.media.seriesId).toBeUndefined();
        expect(it.media.seriesName).toBeUndefined();
        expect(it.media.seasonNumber).toBeUndefined();
        expect(it.media.episodeNumber).toBeUndefined();
    });
});

// `media.type` is a real enum (publicMediaTypeSchema) and is what the client
// routes playback off. rowToItem used to emit
// `toPublicMediaType(row.media_type) ?? row.media_type ?? 'movie'`, i.e. leak the
// raw storage token or silently relabel the row as a movie. Both are worse than
// no card: a "movie" the movie player cannot open.
describe('rowToItem — rows with no public media type are dropped, never relabelled', () => {
    it.each(['tvchannel', 'home_video', 'music'])('drops a %s row', (mediaType) => {
        expect(rowToItem(cwRow({ media_type: mediaType }), 'internal')).toBeNull();
    });

    it('never emits the raw storage token as media.type', () => {
        const out = rowToItem(cwRow({ media_type: 'tvchannel' }), 'internal');
        expect(out?.media.type).not.toBe('tvchannel');
    });

    it('never relabels an unrepresentable row as a movie', () => {
        const out = rowToItem(cwRow({ media_type: 'tvchannel' }), 'internal');
        expect(out?.media.type).not.toBe('movie');
    });

    it('still maps every type it CAN represent (a drop, not a blanket reject)', () => {
        expect(itemFor(cwRow({ media_type: 'tv' }), 'internal').media.type).toBe('series');
        expect(itemFor(cwRow({ media_type: 'episode' }), 'internal').media.type).toBe('episode');
        expect(itemFor(cwRow({ media_type: 'audiobook' }), 'internal').media.type).toBe(
            'audiobook',
        );
    });
});

describe('stale / barely-started drop rules', () => {
    describe('shouldDropFromContinueWatching', () => {
        const HOUR_MS = 60 * 60 * 1000;

        // Real production data from GET /api/continue-watching, ordered exactly
        // as returned (lastPlayedAt DESC). Expected drops: rows 11, 12, 17 —
        // the only rows that are BOTH long-forgotten (>30d) AND either
        // barely-started (<5%) or an audiobook.
        const rows: Array<{
            pos: number;
            title: string;
            mediaType: string;
            ageHours: number;
            pctDone: number;
            expectDrop: boolean;
        }> = [
            {
                pos: 1,
                title: 'Milo Farrow und der Stein',
                mediaType: 'audiobook',
                ageHours: 0.5,
                pctDone: 6.3,
                expectDrop: false,
            },
            {
                pos: 2,
                title: 'Der dunkle Hafen',
                mediaType: 'audiobook',
                ageHours: 1.6,
                pctDone: 81.3,
                expectDrop: false,
            },
            {
                pos: 3,
                title: 'Phoenix',
                mediaType: 'episode',
                ageHours: 4.5,
                pctDone: 91.4,
                expectDrop: false,
            },
            {
                pos: 4,
                title: '001 - Der Super-Papagei',
                mediaType: 'audiobook',
                ageHours: 14.8,
                pctDone: 8.0,
                expectDrop: false,
            },
            {
                pos: 5,
                title: 'The Handmaiden',
                mediaType: 'movie',
                ageHours: 88.7,
                pctDone: 9.2,
                expectDrop: false,
            },
            {
                pos: 6,
                title: 'More Like Gretchen',
                mediaType: 'episode',
                ageHours: 166.3,
                pctDone: 12.9,
                expectDrop: false,
            },
            {
                pos: 7,
                title: 'Thwack',
                mediaType: 'episode',
                ageHours: 451.5,
                pctDone: 57.6,
                expectDrop: false,
            },
            {
                pos: 8,
                title: 'Milo Farrow and the Chamb',
                mediaType: 'movie',
                ageHours: 454.0,
                pctDone: 78.2,
                expectDrop: false,
            },
            {
                pos: 9,
                title: 'Beta Test',
                mediaType: 'episode',
                ageHours: 1095.6,
                pctDone: 19.6,
                expectDrop: false,
            },
            {
                pos: 10,
                title: 'Project Hail Mary',
                mediaType: 'movie',
                ageHours: 2109.1,
                pctDone: 8.1,
                expectDrop: false,
            },
            {
                pos: 11,
                title: 'Magie und Milchschaum',
                mediaType: 'audiobook',
                ageHours: 2901.9,
                pctDone: 3.7,
                expectDrop: true,
            },
            {
                pos: 12,
                title: 'Kinder des Nebels (Mistbor',
                mediaType: 'audiobook',
                ageHours: 3503.6,
                pctDone: 1.6,
                expectDrop: true,
            },
            {
                pos: 13,
                title: 'Nobody Gets the Fleece',
                mediaType: 'episode',
                ageHours: 3740.5,
                pctDone: 38.3,
                expectDrop: false,
            },
            {
                pos: 14,
                title: 'Savior',
                mediaType: 'episode',
                ageHours: 3839.8,
                pctDone: 23.8,
                expectDrop: false,
            },
            {
                pos: 15,
                title: 'The Profligate',
                mediaType: 'episode',
                ageHours: 4023.4,
                pctDone: 32.0,
                expectDrop: false,
            },
            {
                pos: 16,
                title: 'The Sehlat Who Ate Its Tai',
                mediaType: 'episode',
                ageHours: 4023.4,
                pctDone: 24.6,
                expectDrop: false,
            },
            {
                pos: 17,
                title: 'Der Name des Lichtes',
                mediaType: 'audiobook',
                ageHours: 4239.3,
                pctDone: 0.3,
                expectDrop: true,
            },
        ];

        it.each(rows)(
            'row $pos ($title, $mediaType, age=$ageHours h, pct=$pctDone%) → drop=$expectDrop',
            ({ mediaType, ageHours, pctDone, expectDrop }) => {
                expect(
                    shouldDropFromContinueWatching({
                        mediaType,
                        pctDone,
                        ageMs: ageHours * HOUR_MS,
                    }),
                ).toBe(expectDrop);
            },
        );

        it('drops exactly rows 11, 12 and 17 and nothing else', () => {
            const dropped = rows
                .filter((r) =>
                    shouldDropFromContinueWatching({
                        mediaType: r.mediaType,
                        pctDone: r.pctDone,
                        ageMs: r.ageHours * HOUR_MS,
                    }),
                )
                .map((r) => r.pos);
            expect(dropped).toEqual([11, 12, 17]);
        });

        it('never drops on Rule A when duration/pctDone is unknown (undefined), even when very old', () => {
            // Zero/null/absent duration must not compute as 0% and get dropped.
            expect(
                shouldDropFromContinueWatching({
                    mediaType: 'movie',
                    pctDone: undefined,
                    ageMs: 400 * 24 * HOUR_MS,
                }),
            ).toBe(false);
        });

        it('Rule B still drops a stale audiobook even when pctDone is unknown', () => {
            expect(
                shouldDropFromContinueWatching({
                    mediaType: 'audiobook',
                    pctDone: undefined,
                    ageMs: (CW_AUDIOBOOK_STALE_AFTER_DAYS + 1) * 24 * HOUR_MS,
                }),
            ).toBe(true);
        });

        it('Rule A boundary: exactly CW_MIN_PROGRESS_PCT does not count as "barely started"', () => {
            expect(
                shouldDropFromContinueWatching({
                    mediaType: 'movie',
                    pctDone: CW_MIN_PROGRESS_PCT,
                    ageMs: (CW_STALE_AFTER_DAYS + 1) * 24 * HOUR_MS,
                }),
            ).toBe(false);
        });

        it('Rule A boundary: exactly CW_STALE_AFTER_DAYS old does not count as stale yet', () => {
            expect(
                shouldDropFromContinueWatching({
                    mediaType: 'movie',
                    pctDone: 1,
                    ageMs: CW_STALE_AFTER_DAYS * 24 * HOUR_MS,
                }),
            ).toBe(false);
        });

        it('Rule B boundary: exactly CW_AUDIOBOOK_STALE_AFTER_DAYS old does not drop yet', () => {
            expect(
                shouldDropFromContinueWatching({
                    mediaType: 'audiobook',
                    pctDone: 50,
                    ageMs: CW_AUDIOBOOK_STALE_AFTER_DAYS * 24 * HOUR_MS,
                }),
            ).toBe(false);
        });

        it('is case/convention-insensitive on media type (UPPERCASE / PascalCase audiobook)', () => {
            const ageMs = (CW_AUDIOBOOK_STALE_AFTER_DAYS + 1) * 24 * HOUR_MS;
            expect(
                shouldDropFromContinueWatching({ mediaType: 'AUDIOBOOK', pctDone: 50, ageMs }),
            ).toBe(true);
            expect(
                shouldDropFromContinueWatching({ mediaType: 'Audiobook', pctDone: 50, ageMs }),
            ).toBe(true);
        });
    });

    describe('filterStaleContinueWatching', () => {
        it('drops stale audiobook rows and barely-started+old rows, preserving order of survivors', () => {
            const now = Date.now();
            const daysAgo = (days: number) =>
                new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

            const fresh = cwRow({
                media_id: 'fresh',
                media_type: 'episode',
                runtime_ms: 1_000_000,
                resume_position_ms: 900_000, // 90%
                last_event_at: daysAgo(1),
            });
            const staleAudiobook = cwRow({
                media_id: 'stale-audiobook',
                media_type: 'audiobook',
                runtime_ms: 1_000_000,
                resume_position_ms: 500_000, // 50% — progress doesn't save it
                last_event_at: daysAgo(31),
            });
            const barelyStartedOld = cwRow({
                media_id: 'barely-started-old',
                media_type: 'movie',
                runtime_ms: 1_000_000,
                resume_position_ms: 10_000, // 1%
                last_event_at: daysAgo(31),
            });
            const midConsumptionOld = cwRow({
                media_id: 'mid-consumption-old',
                media_type: 'episode',
                runtime_ms: 1_000_000,
                resume_position_ms: 200_000, // 20% — survives despite age
                last_event_at: daysAgo(45),
            });
            const unknownDurationOld = cwRow({
                media_id: 'unknown-duration-old',
                media_type: 'movie',
                runtime_ms: null,
                resume_position_ms: 10_000,
                last_event_at: daysAgo(60),
            });

            const out = filterStaleContinueWatching([
                fresh,
                staleAudiobook,
                barelyStartedOld,
                midConsumptionOld,
                unknownDurationOld,
            ]);

            expect(out.map((r) => r.media_id)).toEqual([
                'fresh',
                'mid-consumption-old',
                'unknown-duration-old',
            ]);
        });

        it('does not mutate the input array', () => {
            const rows = [cwRow({ media_id: 'a' })];
            const before = [...rows];
            filterStaleContinueWatching(rows);
            expect(rows).toEqual(before);
        });
    });

    // GET /feed's `watching` section is fed by the SAME
    // watchManager.getContinueWatching rows as GET /continue-watching, but reads
    // them through the assembled ContinueWatchingItem shape. It shares the pure
    // predicate via this adapter so the two surfaces can't disagree about which
    // rows are stale.
    describe('filterStaleWatchingItems (ContinueWatchingItem shape)', () => {
        const now = Date.now();
        const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

        const cwi = (over: Partial<ContinueWatchingItem>): ContinueWatchingItem =>
            ({
                id: 'x',
                title: 'T',
                mediaType: 'episode',
                watchProgress: 50,
                duration: 3600,
                externalIds: { internal: 'x' },
                updatedAt: daysAgo(1),
                ...over,
            }) as ContinueWatchingItem;

        it('agrees with the row-shaped filter on the same three cases', () => {
            const out = filterStaleWatchingItems([
                cwi({ id: 'fresh', resumeRatio: 0.9, updatedAt: daysAgo(1) }),
                cwi({
                    id: 'stale-audiobook',
                    mediaType: 'audiobook',
                    resumeRatio: 0.5,
                    updatedAt: daysAgo(31),
                }),
                cwi({
                    id: 'barely-started-old',
                    mediaType: 'movie',
                    resumeRatio: 0.01,
                    updatedAt: daysAgo(31),
                }),
                cwi({ id: 'mid-consumption-old', resumeRatio: 0.2, updatedAt: daysAgo(45) }),
            ]);
            expect(out.map((i) => i.id)).toEqual(['fresh', 'mid-consumption-old']);
        });

        it('falls back to watchProgress when resumeRatio is absent', () => {
            const out = filterStaleWatchingItems([
                cwi({
                    id: 'low',
                    resumeRatio: undefined,
                    watchProgress: 1,
                    updatedAt: daysAgo(31),
                }),
                cwi({
                    id: 'high',
                    resumeRatio: undefined,
                    watchProgress: 40,
                    updatedAt: daysAgo(31),
                }),
            ]);
            expect(out.map((i) => i.id)).toEqual(['high']);
        });

        it('never drops an item whose runtime is unknown (cannot be PROVEN barely-started)', () => {
            const out = filterStaleWatchingItems([
                cwi({
                    id: 'no-duration',
                    resumeRatio: undefined,
                    duration: undefined,
                    watchProgress: 0,
                    updatedAt: daysAgo(60),
                }),
            ]);
            expect(out.map((i) => i.id)).toEqual(['no-duration']);
        });

        it('never drops an item with no activity timestamp', () => {
            const out = filterStaleWatchingItems([
                cwi({ id: 'no-ts', resumeRatio: 0, updatedAt: undefined }),
            ]);
            expect(out.map((i) => i.id)).toEqual(['no-ts']);
        });

        it('does not mutate the input array', () => {
            const items = [cwi({ id: 'a' })];
            const before = [...items];
            filterStaleWatchingItems(items);
            expect(items).toEqual(before);
        });
    });

    it('drops seriesName when series_id is null even if series_name fell back to the season title', () => {
        // SQL: series_name = COALESCE(grandparent_title, parent_title). A broken
        // series link (orphaned season) yields series_id=null but series_name =
        // the season's own title — which must NOT be emitted as the series name.
        const it = itemFor(
            cwRow({
                media_type: 'episode',
                title: 'Orphan Episode',
                series_id: null,
                series_name: 'Season 2', // season title leaked via COALESCE fallback
                season_number: 2,
                episode_number: 4,
            }),
            'internal',
        );
        expect(it.media.seriesId).toBeUndefined();
        expect(it.media.seriesName).toBeUndefined();
        // Season/episode numbers still surface — they don't depend on the series id.
        expect(it.media.seasonNumber).toBe(2);
        expect(it.media.episodeNumber).toBe(4);
    });

    it('leaves fields absent for an episode whose series link is null (local-only)', () => {
        const it = itemFor(
            cwRow({
                media_type: 'episode',
                title: 'Orphan Episode',
                series_id: null,
                series_name: null,
                season_number: null,
                episode_number: null,
            }),
            'internal',
        );
        expect(it.media.type).toBe('episode');
        expect(it.media.seriesId).toBeUndefined();
        expect(it.media.seriesName).toBeUndefined();
        expect(it.media.seasonNumber).toBeUndefined();
        expect(it.media.episodeNumber).toBeUndefined();
    });
});

// ── ?types= media-type allow-list ───────────────────────────────────────────
//
// Regression filed by a third-party tvOS client with no audiobook UI: once
// audiobooks are configured they join this rail, and a client that assumes
// every item is a video renders a book as a movie poster into the movie
// playback path. These tests pin the three things that make the allow-list
// actually usable: PUBLIC vocabulary (`series`, matching a row STORED as
// 'tv'), rejection of unknown values, and filtering BEFORE the pagination
// slice so `hasMore` and the page size describe the filtered list.

describe('parseMediaTypeFilter', () => {
    it('maps public series filtering to every compatible storage token', () => {
        expect(toContinueWatchingDatabaseTypes(new Set(['movie', 'series']))).toEqual([
            'movie',
            'tv',
            'show',
            'series',
        ]);
        expect(toContinueWatchingDatabaseTypes(null)).toBeNull();
    });

    it('returns no filter when the param is absent', () => {
        expect(parseMediaTypeFilter(undefined)).toEqual({ allow: null, invalid: [] });
        expect(parseMediaTypeFilter(null)).toEqual({ allow: null, invalid: [] });
    });

    it('parses a comma-separated allow-list', () => {
        const { allow, invalid } = parseMediaTypeFilter('movie,series,episode');
        expect(invalid).toEqual([]);
        expect([...allow!].sort()).toEqual(['episode', 'movie', 'series']);
    });

    it('trims whitespace and is case-insensitive', () => {
        const { allow, invalid } = parseMediaTypeFilter('  Movie , SERIES  ');
        expect(invalid).toEqual([]);
        expect([...allow!].sort()).toEqual(['movie', 'series']);
    });

    it('treats an EMPTY value (?types=) as absent — no filtering, not "allow nothing"', () => {
        // Documented choice: a client building `?types=${selected.join(',')}` from
        // an empty selection must not get an indistinguishable-from-empty rail.
        expect(parseMediaTypeFilter('')).toEqual({ allow: null, invalid: [] });
        expect(parseMediaTypeFilter(',')).toEqual({ allow: null, invalid: [] });
        expect(parseMediaTypeFilter('  ,  ')).toEqual({ allow: null, invalid: [] });
    });

    it('normalizes the legacy storage token `tv`/`show` onto the public `series`', () => {
        // The param takes PUBLIC values; `tv` is the INTERNAL media_items token.
        // Accepting it as an alias (via publicMediaTypeSchema's coercion) is
        // leniency, but what lands in the allow-list is always the public value.
        expect([...parseMediaTypeFilter('tv').allow!]).toEqual(['series']);
        expect([...parseMediaTypeFilter('show').allow!]).toEqual(['series']);
    });

    it('accepts audiobook (an audiobook-only client is a legitimate caller)', () => {
        expect([...parseMediaTypeFilter('audiobook').allow!]).toEqual(['audiobook']);
    });

    it('reports unknown values verbatim and applies NO filter', () => {
        const { allow, invalid } = parseMediaTypeFilter('movies');
        expect(invalid).toEqual(['movies']);
        expect(allow).toBeNull();
    });

    it('invalidates the whole request when ANY token is unknown', () => {
        // Partial acceptance would silently return a different set than asked
        // for — the exact class of bug this param exists to fix.
        const { allow, invalid } = parseMediaTypeFilter('movie,book,series');
        expect(invalid).toEqual(['book']);
        expect(allow).toBeNull();
    });

    it('rejects internal storage-only types that have no public representation', () => {
        expect(parseMediaTypeFilter('tvchannel').invalid).toEqual(['tvchannel']);
        expect(parseMediaTypeFilter('home_video').invalid).toEqual(['home_video']);
    });
});

describe('filterContinueWatchingByType', () => {
    it('returns the input array untouched when there is no filter', () => {
        const rows = [cwRow({ media_id: 'a' }), cwRow({ media_id: 'b', media_type: 'audiobook' })];
        // Same array identity: the no-param path must be byte-identical to the
        // behaviour before this param existed.
        expect(filterContinueWatchingByType(rows, null)).toBe(rows);
    });

    it('?types=series matches a row STORED as media_type "tv" (public ⇄ internal mapping)', () => {
        // The single most important assertion in this file: media_items.media_type
        // stores lowercase 'tv', the public discriminator is 'series'. A bare
        // string compare would return zero rows here.
        const rows = [cwRow({ media_id: 'tv-row', media_type: 'tv' })];
        const out = filterContinueWatchingByType(rows, new Set(['series']));
        expect(out.map((r) => r.media_id)).toEqual(['tv-row']);
    });

    it('does NOT match a row stored as "tv" when only movie is allowed', () => {
        const rows = [cwRow({ media_id: 'tv-row', media_type: 'tv' })];
        expect(filterContinueWatchingByType(rows, new Set(['movie']))).toEqual([]);
    });

    it('drops audiobooks for a video-only allow-list, preserving order of survivors', () => {
        const rows = [
            cwRow({ media_id: 'm1', media_type: 'movie' }),
            cwRow({ media_id: 'b1', media_type: 'audiobook' }),
            cwRow({ media_id: 'e1', media_type: 'episode' }),
            cwRow({ media_id: 'b2', media_type: 'AUDIOBOOK' }), // case-insensitive
            cwRow({ media_id: 's1', media_type: 'tv' }),
        ];
        const out = filterContinueWatchingByType(rows, new Set(['movie', 'series', 'episode']));
        expect(out.map((r) => r.media_id)).toEqual(['m1', 'e1', 's1']);
    });

    it('drops rows whose stored type has no public representation when a filter is active', () => {
        // 'tvchannel' cannot be a member of a list of PUBLIC types, and an
        // allow-list means "emit only what I asked for".
        const rows = [
            cwRow({ media_id: 'ch', media_type: 'tvchannel' }),
            cwRow({ media_id: 'm', media_type: 'movie' }),
        ];
        expect(
            filterContinueWatchingByType(rows, new Set(['movie', 'series', 'episode'])).map(
                (r) => r.media_id,
            ),
        ).toEqual(['m']);
        // …but is untouched with no filter (no behaviour change for existing callers).
        expect(filterContinueWatchingByType(rows, null).map((r) => r.media_id)).toEqual([
            'ch',
            'm',
        ]);
    });

    it('does not mutate the input array', () => {
        const rows = [cwRow({ media_id: 'a', media_type: 'audiobook' })];
        const before = [...rows];
        filterContinueWatchingByType(rows, new Set(['movie']));
        expect(rows).toEqual(before);
    });
});

describe('GET /continue-watching?types= (handler)', () => {
    const ctx = { surface: 'v1' as const };

    function makeEvent(query: string): RequestEvent {
        return {
            locals: { user: { userId: 'u1', username: 'alice' } },
            url: new URL(`http://localhost/api/v1/continue-watching${query}`),
            params: {},
            request: new Request(`http://localhost/api/v1/continue-watching${query}`),
        } as unknown as RequestEvent;
    }

    /** Fresh, well-progressed rows so the staleness rules never fire here. */
    function row(id: string, mediaType: string, minutesAgo: number): ContinueWatchingRow {
        return cwRow({
            media_id: id,
            media_type: mediaType,
            title: id,
            runtime_ms: 1_000_000,
            resume_position_ms: 500_000, // 50%
            last_event_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        });
    }

    // Interleaved so a filter applied AFTER the slice would punch holes in the
    // page instead of returning a full one.
    const interleaved = [
        row('123e4567-e89b-42d3-a456-426614174001', 'movie', 1),
        row('123e4567-e89b-42d3-a456-426614174002', 'audiobook', 2),
        row('123e4567-e89b-42d3-a456-426614174003', 'movie', 3),
        row('123e4567-e89b-42d3-a456-426614174004', 'audiobook', 4),
        row('123e4567-e89b-42d3-a456-426614174005', 'movie', 5),
        row('123e4567-e89b-42d3-a456-426614174006', 'audiobook', 6),
    ];

    async function get(query: string): Promise<{ status: number; body: never }> {
        const res = (await def.handlers.GET!(makeEvent(query), ctx)) as Response;
        return { status: res.status, body: (await res.json()) as never };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockBuildAccessContext.mockResolvedValue({ userId: 'u1', langs: undefined });
        mockGetContinueWatchingPage.mockImplementation(
            async (
                _userId: string,
                limit: number,
                page: { offset: number; mediaTypes: string[] | null },
            ) =>
                orderByLastActivity(
                    filterStaleContinueWatching(
                        interleaved.filter(
                            (item) =>
                                page.mediaTypes === null ||
                                page.mediaTypes.includes(item.media_type),
                        ),
                    ),
                ).slice(page.offset, page.offset + limit),
        );
    });

    it('omitting ?types= returns every type — today’s behaviour, unchanged', async () => {
        const { status, body } = await get('?limit=10');
        expect(status).toBe(200);
        const b = body as unknown as { items: Array<{ id: string; type: string }> };
        expect(b.items.map((i) => i.id)).toEqual([
            '123e4567-e89b-42d3-a456-426614174001',
            '123e4567-e89b-42d3-a456-426614174002',
            '123e4567-e89b-42d3-a456-426614174003',
            '123e4567-e89b-42d3-a456-426614174004',
            '123e4567-e89b-42d3-a456-426614174005',
            '123e4567-e89b-42d3-a456-426614174006',
        ]);
        expect(b.items.some((i) => i.type === 'audiobook')).toBe(true);
        expect(mockGetContinueWatchingPage).toHaveBeenCalledWith(
            'u1',
            11,
            expect.objectContaining({ offset: 0, mediaTypes: null }),
            expect.objectContaining({ deniedGroupIds: undefined, ageRating: null }),
        );
    });

    it('a RESTRICTED access context reaches getExactContinueWatchingPage as deniedGroupIds/ageRating', async () => {
        // C3 (2026-09-18 fix-plan-4), review fix: the earlier assertion only
        // pinned the UNRESTRICTED case (ctx has no deniedGroupIds/maxAgeRating
        // at all), which passes whether or not the handler actually threads
        // the boundary through. This is the handler-to-query plumbing seam —
        // the SQL-level seam itself is covered by the query's own integration
        // test.
        mockBuildAccessContext.mockResolvedValue({
            userId: 'u1',
            langs: undefined,
            deniedGroupIds: ['g1'],
            maxAgeRating: 12,
            allowUnrated: false,
        });

        const { status } = await get('?limit=10');
        expect(status).toBe(200);
        expect(mockGetContinueWatchingPage).toHaveBeenCalledWith(
            'u1',
            11,
            expect.objectContaining({ offset: 0, mediaTypes: null }),
            { deniedGroupIds: ['g1'], ageRating: { maxAgeRating: 12, allowUnrated: false } },
        );
    });

    it('an EMPTY ?types= behaves exactly like omitting it', async () => {
        const omitted = await get('?limit=10');
        const empty = await get('?limit=10&types=');
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual(omitted.body);
    });

    it('filters audiobooks out for a video-only allow-list', async () => {
        const { status, body } = await get('?limit=10&types=movie,series,episode');
        expect(status).toBe(200);
        const b = body as unknown as { items: Array<{ id: string; type: string }> };
        expect(b.items.map((i) => i.id)).toEqual([
            '123e4567-e89b-42d3-a456-426614174001',
            '123e4567-e89b-42d3-a456-426614174003',
            '123e4567-e89b-42d3-a456-426614174005',
        ]);
        expect(b.items.every((i) => i.type === 'movie')).toBe(true);
    });

    it('filters BEFORE pagination: a filtered page is FULL, and page.hasMore/total describe the FILTERED set', async () => {
        // 6 rows: 3 movies + 3 audiobooks, interleaved. limit=3, movies only.
        //   filter-before-slice (correct): 3 items, hasMore FALSE (3 movies total)
        //   filter-after-slice  (the bug): 2 items, hasMore TRUE  (6 unfiltered rows)
        const { status, body } = await get('?limit=3&types=movie');
        expect(status).toBe(200);
        const b = body as unknown as {
            items: Array<{ id: string }>;
            page: { limit: number; offset: number; hasMore: boolean; total?: number };
        };
        expect(b.items.map((i) => i.id)).toEqual([
            '123e4567-e89b-42d3-a456-426614174001',
            '123e4567-e89b-42d3-a456-426614174003',
            '123e4567-e89b-42d3-a456-426614174005',
        ]);
        expect(b.items).toHaveLength(3);
        expect(b.page.hasMore).toBe(false);
        // `total` remains intentionally absent for response compatibility.
        expect(b.page.total).toBeUndefined();

        // Same request WITHOUT the filter still reports more to come, proving the
        // hasMore above came from the filtered array and not the raw window.
        const unfiltered = await get('?limit=3');
        expect((unfiltered.body as unknown as { page: { hasMore: boolean } }).page.hasMore).toBe(
            true,
        );
    });

    it('hasMore stays TRUE when the filtered set is longer than the page', async () => {
        const { body } = await get('?limit=2&types=movie');
        const b = body as unknown as {
            items: Array<{ id: string }>;
            page: { hasMore: boolean };
        };
        expect(b.items.map((i) => i.id)).toEqual([
            '123e4567-e89b-42d3-a456-426614174001',
            '123e4567-e89b-42d3-a456-426614174003',
        ]);
        expect(b.page.hasMore).toBe(true);
    });

    it('?types=series matches rows stored as media_type "tv" end-to-end', async () => {
        mockGetContinueWatchingPage.mockResolvedValue([
            row('123e4567-e89b-42d3-a456-426614174007', 'tv', 1),
        ]);
        const { body } = await get('?limit=10&types=series');
        const b = body as unknown as { items: Array<{ id: string; type: string }> };
        expect(b.items.map((i) => i.id)).toEqual(['123e4567-e89b-42d3-a456-426614174007']);
        // …and the emitted discriminator is the PUBLIC value, never the stored 'tv'.
        expect(b.items[0]!.type).toBe('series');
    });

    it('composes with the staleness filter instead of replacing it', async () => {
        mockGetContinueWatchingPage.mockResolvedValue([
            row('123e4567-e89b-42d3-a456-426614174008', 'audiobook', 10),
        ]);
        // Audiobook-only client: the stale one is still gone.
        const { body } = await get('?limit=10&types=audiobook');
        const b = body as unknown as { items: Array<{ id: string }> };
        expect(b.items.map((i) => i.id)).toEqual(['123e4567-e89b-42d3-a456-426614174008']);
    });

    it('executes one exact SQL page with filter, offset, and limit+1', async () => {
        await get('?limit=3&offset=2&types=movie,series');

        expect(mockGetContinueWatchingPage).toHaveBeenCalledOnce();
        expect(mockGetContinueWatchingPage).toHaveBeenCalledWith(
            'u1',
            4,
            expect.objectContaining({
                offset: 2,
                mediaTypes: ['movie', 'tv', 'show', 'series'],
            }),
            expect.objectContaining({ deniedGroupIds: undefined, ageRating: null }),
        );
    });

    it('422s an unknown type with a validation problem naming the offender and the vocabulary', async () => {
        const { status, body } = await get('?types=book');
        expect(status).toBe(422);
        const b = body as unknown as {
            code: string;
            details?: Array<{ field: string; message: string }>;
        };
        expect(b.code).toBe('validation_failed');
        expect(b.details?.[0]?.field).toBe('types');
        expect(b.details?.[0]?.message).toContain('book');
        expect(b.details?.[0]?.message).toContain('audiobook'); // allowed vocabulary
        // Rejected BEFORE any query — an invalid filter must never fall back to
        // "return everything".
        expect(mockGetContinueWatchingPage).not.toHaveBeenCalled();
    });

    it('422s when only ONE of several types is unknown', async () => {
        const { status } = await get('?types=movie,podcast');
        expect(status).toBe(422);
        expect(mockGetContinueWatchingPage).not.toHaveBeenCalled();
    });
});
