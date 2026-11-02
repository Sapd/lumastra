// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the admin media-browser filter mappers.
 *
 * These two functions decide which `media_type` rows an operator can reach at
 * all. `resolveTypes` produces the `types` array handed to
 * `listAdminMediaItems` / `countAdminMediaItems`, and a value missing from
 * every branch is silently invisible in the admin UI — which is how
 * `audiobook`, `radio`, `book` and `product` used to be unreachable even under
 * the "Everything" tab.
 */

import { describe, it, expect } from 'vitest';
import { buildMusicHygieneLink } from '$lib/shared/admin-media-links.js';
import {
    isHeuristicMusicHygieneFinding,
    MUSIC_HYGIENE_FINDINGS,
    MUSIC_HYGIENE_VIEW,
} from '$lib/shared/music-hygiene.js';
import {
    MEDIA_BROWSER_FILTER_VALUES,
    resolveBrowserFilter,
    resolveTypes,
    inferDomain,
    defaultTypeForDomain,
    defaultSearchTypeForDomain,
    MUSIC_TYPES,
    OTHER_TYPES,
    AUDIOBOOK_TYPES,
    ALL_BROWSABLE_TYPES,
    NON_BROWSABLE_TYPES,
    domainSupportsProviderIdentity,
    advancedFilterKeysForDomain,
    pruneFiltersForDomain,
    domainShowsBookColumns,
    ancestryPlanFor,
    columnAppliesTo,
    defaultSortForType,
    ancestrySortKeyFor,
    isGroupingSort,
    resolveSortUrlParam,
    VALID_SORT_COLS,
} from './media-filters.js';
import { INTERNAL_MEDIA_TYPES } from '$lib/shared/media-type-domain';

describe('resolveTypes — pre-existing behaviour is preserved', () => {
    it('maps the default/unknown filter to movies + series', () => {
        expect(resolveTypes('main')).toEqual(['movie', 'tv']);
        expect(resolveTypes('')).toEqual(['movie', 'tv']);
        expect(resolveTypes('not-a-real-filter')).toEqual(['movie', 'tv']);
    });

    it('passes single video/music/other types straight through', () => {
        for (const t of [
            'movie',
            'tv',
            'episode',
            'season',
            'artist',
            'album',
            'track',
            'home_video',
            'training',
            'educational',
            'personal',
        ]) {
            expect(resolveTypes(t)).toEqual([t]);
        }
    });

    it('expands the music and other_all group filters', () => {
        expect(resolveTypes('music')).toEqual([...MUSIC_TYPES]);
        expect(resolveTypes('other_all')).toEqual([...OTHER_TYPES]);
    });

    it('returns a fresh array so a caller cannot mutate the shared constants', () => {
        const first = resolveTypes('music');
        first.push('mutated');
        expect(resolveTypes('music')).toEqual([...MUSIC_TYPES]);
    });

    it('restricts the unidentified domain to the types TMDB identification applies to', () => {
        expect(resolveTypes('unidentified_all', 'unidentified')).toEqual(['movie', 'tv']);
        expect(resolveTypes('movie', 'unidentified')).toEqual(['movie']);
        expect(resolveTypes('tv', 'unidentified')).toEqual(['tv']);
        // The unidentified domain ignores type filters it cannot honour —
        // including audiobook, which has no TMDB identity to be missing.
        expect(resolveTypes('audiobook', 'unidentified')).toEqual(['movie', 'tv']);
        expect(resolveTypes('track', 'unidentified')).toEqual(['movie', 'tv']);
    });
});

describe('resolveTypes — audiobooks', () => {
    it('resolves the audiobook filter to the audiobook media_type', () => {
        expect(resolveTypes('audiobook')).toEqual(['audiobook']);
    });

    it('includes audiobooks in the "all" (Everything) filter', () => {
        expect(resolveTypes('all')).toContain('audiobook');
    });

    it('keeps "all" a superset of every group filter', () => {
        const all = new Set(resolveTypes('all'));
        for (const t of [
            ...resolveTypes('main'),
            'episode',
            'season',
            ...MUSIC_TYPES,
            ...OTHER_TYPES,
            ...AUDIOBOOK_TYPES,
        ]) {
            expect(all.has(t)).toBe(true);
        }
    });

    it('does NOT fold audiobook into other_all — it is a peer of music, not an "other" type', () => {
        // ENTERTAINMENT_LIBRARY_TYPES lists audiobook alongside music; burying it
        // in other_all would also make the Other tab claim Hörbücher libraries.
        expect(resolveTypes('other_all')).not.toContain('audiobook');
        expect(OTHER_TYPES).not.toContain('audiobook');
    });

    it('does NOT leak audiobooks into the video or music filters', () => {
        for (const t of ['main', 'movie', 'tv', 'episode', 'season', 'music', 'artist', 'track']) {
            expect(resolveTypes(t)).not.toContain('audiobook');
        }
    });

    it('never returns an empty type set for a known filter (empty → ANY({}) → zero rows)', () => {
        for (const t of [
            'main',
            'all',
            'music',
            'other_all',
            'audiobook',
            'movie',
            'tv',
            'episode',
            'season',
        ]) {
            expect(resolveTypes(t).length).toBeGreaterThan(0);
        }
    });
});

describe('defaultSearchTypeForDomain', () => {
    it('widens Music to every music type and leaves other domains on their default', () => {
        expect(defaultSearchTypeForDomain('music')).toBe('music');
        for (const domain of ['video', 'audiobook', 'other', 'everything', 'unidentified']) {
            expect(defaultSearchTypeForDomain(domain)).toBe(defaultTypeForDomain(domain));
        }
    });
});

describe('inferDomain', () => {
    it('keeps the pre-existing domain mapping', () => {
        expect(inferDomain('main')).toBe('video');
        expect(inferDomain('movie')).toBe('video');
        expect(inferDomain('episode')).toBe('video');
        expect(inferDomain('music')).toBe('music');
        expect(inferDomain('album')).toBe('music');
        expect(inferDomain('other_all')).toBe('other');
        expect(inferDomain('personal')).toBe('other');
        expect(inferDomain('all')).toBe('everything');
        expect(inferDomain('unidentified_all')).toBe('unidentified');
        expect(inferDomain('file_health')).toBe('file_health');
        expect(inferDomain('integrity')).toBe('integrity');
        expect(inferDomain('quarantine')).toBe('quarantine');
        expect(inferDomain('nonsense')).toBe('video');
    });

    it('gives audiobooks their own domain rather than folding them into other/video', () => {
        expect(inferDomain('audiobook')).toBe('audiobook');
    });

    /**
     * The pairing invariant. `?type=X` with no `?domain=` resolves the domain via
     * inferDomain and the type set via resolveTypes(X, thatDomain) — if the
     * inferred domain changed the resolution, the page would render one domain's
     * chips over another domain's rows.
     */
    it('resolves the same type set with and without the inferred domain', () => {
        for (const t of [
            'main',
            'movie',
            'tv',
            'episode',
            'season',
            'music',
            'artist',
            'album',
            'track',
            'audiobook',
            'other_all',
            'home_video',
            'all',
        ]) {
            expect(resolveTypes(t, inferDomain(t))).toEqual(resolveTypes(t));
        }
    });
});

describe('defaultTypeForDomain', () => {
    it('gives every domain a type filter that resolves inside that domain', () => {
        // The bug this closes: `?domain=X` without `?type=` used to fall back to
        // 'main' for every domain but 'unidentified', so a bookmarked
        // ?domain=audiobook (or ?domain=music) rendered that tab over a list of
        // movies. The domain buttons always send both params, so only deep links
        // ever hit this path.
        expect(defaultTypeForDomain('video')).toBe('main');
        expect(defaultTypeForDomain('music')).toBe('artist');
        expect(defaultTypeForDomain('audiobook')).toBe('audiobook');
        expect(defaultTypeForDomain('other')).toBe('other_all');
        expect(defaultTypeForDomain('everything')).toBe('all');
        expect(defaultTypeForDomain('unidentified')).toBe('unidentified_all');
    });

    it('falls back to the movies+series default for an unknown domain', () => {
        expect(defaultTypeForDomain('not-a-domain')).toBe('main');
        expect(defaultTypeForDomain('')).toBe('main');
    });

    it('round-trips: the default type infers back to the domain it came from', () => {
        for (const domain of ['video', 'music', 'audiobook', 'other', 'everything']) {
            expect(inferDomain(defaultTypeForDomain(domain))).toBe(domain);
        }
    });

    it('resolves a non-empty, domain-appropriate type set for each default', () => {
        expect(resolveTypes(defaultTypeForDomain('audiobook'), 'audiobook')).toEqual(['audiobook']);
        expect(resolveTypes(defaultTypeForDomain('music'), 'music')).toEqual(['artist']);
        expect(resolveTypes(defaultTypeForDomain('other'), 'other')).toEqual([...OTHER_TYPES]);
        expect(resolveTypes(defaultTypeForDomain('video'), 'video')).toEqual(['movie', 'tv']);
        expect(resolveTypes(defaultTypeForDomain('unidentified'), 'unidentified')).toEqual([
            'movie',
            'tv',
        ]);
    });
});

describe('type-set constants', () => {
    it('ALL_BROWSABLE_TYPES has no duplicates', () => {
        expect(new Set(ALL_BROWSABLE_TYPES).size).toBe(ALL_BROWSABLE_TYPES.length);
    });

    it('the four groups are mutually exclusive', () => {
        const video = ['movie', 'tv', 'episode', 'season'];
        const groups = [video, MUSIC_TYPES, AUDIOBOOK_TYPES, OTHER_TYPES];
        for (let i = 0; i < groups.length; i++) {
            for (let j = i + 1; j < groups.length; j++) {
                const overlap = groups[i].filter((t) =>
                    (groups[j] as readonly string[]).includes(t),
                );
                expect(overlap).toEqual([]);
            }
        }
    });
});

describe('domainSupportsProviderIdentity', () => {
    it('is false for audiobooks — they are identified by their ABS item id', () => {
        expect(domainSupportsProviderIdentity('audiobook')).toBe(false);
    });

    it('is false for music — cover art and bio replace the TMDB/Jellyfin pair', () => {
        expect(domainSupportsProviderIdentity('music')).toBe(false);
    });

    it('is true for the video and everything domains', () => {
        expect(domainSupportsProviderIdentity('video')).toBe(true);
        expect(domainSupportsProviderIdentity('everything')).toBe(true);
        expect(domainSupportsProviderIdentity('unidentified')).toBe(true);
    });
});

describe('advancedFilterKeysForDomain', () => {
    it('hides the TMDB, Jellyfin and embedding filters in the audiobook domain', () => {
        const keys = advancedFilterKeysForDomain('audiobook');

        expect(keys).not.toContain('missing_tmdb');
        expect(keys).not.toContain('missing_jf');
        expect(keys).not.toContain('has_embedding');
    });

    it('keeps the filters that still mean something for a book', () => {
        const keys = advancedFilterKeysForDomain('audiobook');

        expect(keys).toContain('missing_poster');
        expect(keys).toContain('missing_overview');
        expect(keys).toContain('locked');
        expect(keys).toContain('local_only');
        expect(keys).toContain('custom_poster');
    });

    it('offers every filter in the video domain', () => {
        const keys = advancedFilterKeysForDomain('video');

        expect(keys).toContain('missing_tmdb');
        expect(keys).toContain('missing_jf');
        expect(keys).toContain('has_embedding');
        expect(keys).toContain('missing_poster');
    });
});

describe('pruneFiltersForDomain', () => {
    /**
     * The bug this exists to prevent: a filter is only *hidden* in the audiobook
     * domain, not cleared. An operator who ticks "Missing TMDB ID" on the video
     * tab and then switches to Audiobooks would carry `?missing_tmdb=1` into a
     * domain where every row matches nothing — an empty list with no visible
     * filter chip explaining why.
     */
    it('drops a carried-over TMDB filter when switching into the audiobook domain', () => {
        const params = new URLSearchParams({
            domain: 'audiobook',
            missing_tmdb: '1',
            missing_poster: '1',
        });

        pruneFiltersForDomain(params, 'audiobook');

        expect(params.get('missing_tmdb')).toBeNull();
        expect(params.get('missing_poster')).toBe('1');
    });

    it('drops the Jellyfin and embedding filters too', () => {
        const params = new URLSearchParams({ missing_jf: '1', has_embedding: '1' });

        pruneFiltersForDomain(params, 'audiobook');

        expect(params.get('missing_jf')).toBeNull();
        expect(params.get('has_embedding')).toBeNull();
    });

    it('leaves every filter alone in a domain that supports them', () => {
        const params = new URLSearchParams({ missing_tmdb: '1', has_embedding: '1' });

        pruneFiltersForDomain(params, 'video');

        expect(params.get('missing_tmdb')).toBe('1');
        expect(params.get('has_embedding')).toBe('1');
    });

    /**
     * The production bug, reproduced as a URL: an operator picks a library
     * while browsing Music, clicks Audiobooks, and lands on
     * `?domain=audiobook&type=audiobook&library=<a music group>`. A library
     * group holds exactly ONE media type, so that group contains no audiobook
     * and the tab renders zero rows — of 1,202 that exist.
     *
     * Revert-check: delete `params.delete('library')` from
     * `pruneFiltersForDomain`.
     */
    it('drops a library carried into the audiobook domain', () => {
        const params = new URLSearchParams({
            domain: 'audiobook',
            type: 'audiobook',
            library: '31c87d32-5b31-494c-99b5-6157403a923d',
        });

        pruneFiltersForDomain(params, 'audiobook');

        expect(params.get('library')).toBeNull();
        // The switch must not also throw away what the operator is looking at.
        expect(params.get('type')).toBe('audiobook');
    });

    /**
     * The ORDERING assertion, and the reason it is a separate test.
     *
     * `library` is deleted BEFORE the `domainSupportsProviderIdentity` early
     * return. Move the delete below that return and every provider-identity
     * domain — video, the one an operator switches out of most — silently keeps
     * carrying the library again, while the audiobook test above stays green.
     *
     * Revert-check: move `params.delete('library')` after the early return.
     */
    it('drops the library in a provider-identity domain too', () => {
        const params = new URLSearchParams({
            library: '31c87d32-5b31-494c-99b5-6157403a923d',
            missing_tmdb: '1',
        });

        pruneFiltersForDomain(params, 'video');

        expect(params.get('library')).toBeNull();
        // Cross-wire guard: dropping the library must not be implemented by
        // pruning the provider-identity filters in every domain instead.
        expect(params.get('missing_tmdb')).toBe('1');
    });

    /**
     * `library` is the only scope param pruned here. The domain-neutral filters
     * are not: they mean the same thing in every domain and each one renders a
     * control and a chip wherever it applies.
     *
     * Revert-check: add any of these keys to the delete list.
     */
    it('leaves the domain-neutral filters alone while dropping the library', () => {
        const params = new URLSearchParams({
            library: 'abc',
            missing_poster: '1',
            missing_overview: '1',
            locked: '1',
            local_only: '1',
            custom_poster: '1',
            unavailable: '1',
            dismissed: '1',
        });

        pruneFiltersForDomain(params, 'audiobook');

        expect(params.get('library')).toBeNull();
        for (const key of [
            'missing_poster',
            'missing_overview',
            'locked',
            'local_only',
            'custom_poster',
            'unavailable',
            'dismissed',
        ]) {
            expect(params.get(key), key).toBe('1');
        }
    });
});

describe('domainShowsBookColumns', () => {
    it('is true only for the audiobook domain', () => {
        expect(domainShowsBookColumns('audiobook')).toBe(true);
        expect(domainShowsBookColumns('video')).toBe(false);
        expect(domainShowsBookColumns('music')).toBe(false);
        expect(domainShowsBookColumns('everything')).toBe(false);
    });
});

describe('music lands on artists', () => {
    // 31,809 interleaved artists+albums+tracks sorted by title put zero artists
    // on page one of a 637-page list. 642 artists is 13 pages and navigable.
    it('defaults the music domain to the artist type', () => {
        expect(defaultTypeForDomain('music')).toBe('artist');
    });

    it('keeps the artist type inferring back to the music domain', () => {
        // The pair is load-bearing: a type that resolves one way but infers a
        // different domain renders the wrong chips and the wrong stats tiles.
        expect(inferDomain(defaultTypeForDomain('music'))).toBe('music');
    });

    it('leaves every other domain default unchanged', () => {
        expect(defaultTypeForDomain('video')).toBe('main');
        expect(defaultTypeForDomain('audiobook')).toBe('audiobook');
        expect(defaultTypeForDomain('other')).toBe('other_all');
        expect(defaultTypeForDomain('everything')).toBe('all');
        expect(defaultTypeForDomain('unidentified')).toBe('unidentified_all');
    });

    it('still offers the all-music type when explicitly asked for', () => {
        expect(resolveTypes('music')).toEqual([...MUSIC_TYPES]);
    });
});

describe('ancestryPlanFor', () => {
    it('labels a track by album and artist', () => {
        expect(ancestryPlanFor('music', 'track')).toEqual({ parent: 'album', root: 'artist' });
    });

    it('labels an album by artist, with no second level', () => {
        expect(ancestryPlanFor('music', 'album')).toEqual({ parent: 'artist', root: null });
    });

    it('labels an episode by season and series', () => {
        expect(ancestryPlanFor('video', 'episode')).toEqual({ parent: 'season', root: 'series' });
    });

    it('labels a season by series, with no second level', () => {
        expect(ancestryPlanFor('video', 'season')).toEqual({ parent: 'series', root: null });
    });

    it('offers nothing for root types that have no ancestry', () => {
        expect(ancestryPlanFor('music', 'artist')).toEqual({ parent: null, root: null });
        expect(ancestryPlanFor('video', 'movie')).toEqual({ parent: null, root: null });
        expect(ancestryPlanFor('video', 'tv')).toEqual({ parent: null, root: null });
        expect(ancestryPlanFor('audiobook', 'audiobook')).toEqual({ parent: null, root: null });
    });

    it('offers nothing for the mixed movies+series view', () => {
        // `main` is ['movie','tv'] — both root types.
        expect(ancestryPlanFor('video', 'main')).toEqual({ parent: null, root: null });
    });

    it('uses generic labels in the Everything view, where types are mixed', () => {
        expect(ancestryPlanFor('everything', 'all')).toEqual({ parent: 'parent', root: 'root' });
    });

    it('uses generic labels in the All Music view, where types are mixed', () => {
        // `music` mixes artist + album + track rows exactly like Everything
        // mixes types, just scoped to music, so it gets the same treatment.
        expect(ancestryPlanFor('music', 'music')).toEqual({ parent: 'parent', root: 'root' });
    });

    it('agrees between the two mixed-hierarchy views', () => {
        expect(ancestryPlanFor('music', 'music')).toEqual(ancestryPlanFor('everything', 'all'));
    });

    it('distinguishes the episodes view from the movies view within the SAME domain', () => {
        // There is no "episode domain": inferDomain('episode') is 'video'. A
        // domain-only gate cannot tell these apart.
        expect(inferDomain('episode')).toBe('video');
        expect(ancestryPlanFor('video', 'episode')).not.toEqual(ancestryPlanFor('video', 'movie'));
    });
});

describe('columnAppliesTo', () => {
    it('keeps the book columns to the audiobook domain', () => {
        expect(columnAppliesTo('author', 'audiobook', 'audiobook')).toBe(true);
        expect(columnAppliesTo('author', 'video', 'main')).toBe(false);
    });

    it('keeps the TMDB column to provider-identified domains', () => {
        expect(columnAppliesTo('tmdb', 'video', 'main')).toBe(true);
        expect(columnAppliesTo('tmdb', 'music', 'artist')).toBe(false);
        expect(columnAppliesTo('tmdb', 'audiobook', 'audiobook')).toBe(false);
    });

    it('shows the ancestry columns only where the plan offers them', () => {
        expect(columnAppliesTo('ancestryParent', 'music', 'track')).toBe(true);
        expect(columnAppliesTo('ancestryRoot', 'music', 'track')).toBe(true);
        expect(columnAppliesTo('ancestryParent', 'music', 'album')).toBe(true);
        expect(columnAppliesTo('ancestryRoot', 'music', 'album')).toBe(false);
        expect(columnAppliesTo('ancestryParent', 'music', 'artist')).toBe(false);
    });

    it('shows the ancestry columns on the mixed All Music view', () => {
        expect(columnAppliesTo('ancestryParent', 'music', 'music')).toBe(true);
        expect(columnAppliesTo('ancestryRoot', 'music', 'music')).toBe(true);
    });

    it('hides the children column on leaf types only', () => {
        // Under the artist-first default, album count IS meaningful on an
        // artist row — so this is decided per TYPE, never per domain.
        expect(columnAppliesTo('children', 'music', 'artist')).toBe(true);
        expect(columnAppliesTo('children', 'music', 'album')).toBe(true);
        expect(columnAppliesTo('children', 'video', 'main')).toBe(true);
    });

    it('keeps the children column on movies, which parent their extras', () => {
        // `media_type='extra'` rows carry `parent_id` = the movie
        // (insertExtraMediaItem, written by processExtra), and the browser's
        // child_count lateral counts children unfiltered — so a film with a
        // trailer has a real, non-zero count to show.
        expect(columnAppliesTo('children', 'video', 'movie')).toBe(true);
    });

    it('keeps the children column on episodes and tracks, which CAN parent extras', () => {
        // The criterion is "can this type EVER be a parent_id target", not
        // "usually isn't" — hiding a sparse-but-real count is the same defect
        // as the populated `year` this file once suppressed on tracks.
        //
        // episode: processExtra's primaryFilePath match resolves
        // `S01E01-trailer.mkv` to `S01E01.mkv`'s own item, and
        // findParentMediaItemByFolder on a season folder returns an episode
        // outright. Neither constrains media_type beyond `!= 'extra'`.
        //
        // track: walkExtras applies its hasPrimaryVideo gate ONLY to sibling
        // suffix-extras — the EXTRAS_FOLDER_MAP subfolder branch is ungated,
        // and walkExtras runs on every library path including music. A video
        // under `Artist/Album/featurettes/` resolves its parent from the album
        // folder, whose files belong to track rows.
        expect(columnAppliesTo('children', 'video', 'episode')).toBe(true);
        expect(columnAppliesTo('children', 'music', 'track')).toBe(true);
    });

    it('hides the children column on audiobooks, the one genuine leaf', () => {
        // insertAudiobook is the only writer of media_type='audiobook', it sets
        // no parent_id, and audiobook rows carry NO media_files rows by design
        // (FILELESS_BY_DESIGN_MEDIA_TYPES) — every parent-resolution query in
        // processExtra joins through media_files, so none can return one.
        expect(columnAppliesTo('children', 'audiobook', 'audiobook')).toBe(false);
    });

    it('hides the year column only where it is universally absent', () => {
        // Tracks DO carry a year: audio-processor.ts inserts every track with
        // `year: effectiveYear` (tags.year ?? extractYearFromFolder). Hiding the
        // column there also removed it from the picker and made sorting tracks
        // by year unreachable — the header is `sortUrl('year')`'s only caller.
        // Artists are the genuine case: findOrCreateMusicArtist writes no year.
        expect(columnAppliesTo('year', 'music', 'album')).toBe(true);
        expect(columnAppliesTo('year', 'music', 'track')).toBe(true);
        expect(columnAppliesTo('year', 'music', 'artist')).toBe(false);
        expect(columnAppliesTo('year', 'video', 'main')).toBe(true);
    });

    // The four `other`-domain chips (domainTypeFilters.other in +page.svelte)
    // had NO coverage at all, so nothing pinned what columnAppliesTo answers for
    // them. Verified against the schema and the scanner rather than assumed:
    //
    //   home_video / personal — LIBRARY_TYPE_TEMPLATES gives both
    //     hierarchyMode 'flat', so createPersonalMediaItem mints one root item
    //     per file, passing `year` through (parsed from the filename/folder).
    //     They own media_files rows, so the extras paths can parent to them.
    //   training / educational — hierarchyMode 'series', so
    //     findOrCreateSeriesHierarchy mints a `training`/`educational` ROOT row
    //     that parents season rows outright, and findOrCreateSeries is passed
    //     the same `year`.
    //
    // So all four: children YES, year YES, and no ancestry — each is a root
    // (parent_id IS NULL); being a PARENT of seasons is not the same as having
    // an ancestor to name.
    describe.each(['home_video', 'training', 'educational', 'personal', 'other_all'])(
        'the %s view',
        (typeFilter) => {
            it('offers the children column — these types parent real rows', () => {
                expect(columnAppliesTo('children', 'other', typeFilter)).toBe(true);
            });

            it('offers the year column — the scanner writes one', () => {
                expect(columnAppliesTo('year', 'other', typeFilter)).toBe(true);
            });

            it('offers no ancestry columns — every one of them is a root type', () => {
                expect(columnAppliesTo('ancestryParent', 'other', typeFilter)).toBe(false);
                expect(columnAppliesTo('ancestryRoot', 'other', typeFilter)).toBe(false);
            });
        },
    );

    it('leaves ordinary columns applicable everywhere', () => {
        for (const [d, t] of [
            ['video', 'main'],
            ['music', 'track'],
            ['audiobook', 'audiobook'],
            ['everything', 'all'],
        ]) {
            expect(columnAppliesTo('title', d, t)).toBe(true);
            expect(columnAppliesTo('actions', d, t)).toBe(true);
        }
    });
});

describe('ancestry columns reach the views that need them', () => {
    const isCol = (key: string, d: string, t: string) => columnAppliesTo(key, d, t);

    it('shows both ancestry columns on tracks and episodes', () => {
        for (const [d, t] of [
            ['music', 'track'],
            ['video', 'episode'],
        ]) {
            expect(isCol('ancestryParent', d, t)).toBe(true);
            expect(isCol('ancestryRoot', d, t)).toBe(true);
        }
    });

    it('shows exactly one on albums and seasons', () => {
        for (const [d, t] of [
            ['music', 'album'],
            ['video', 'season'],
        ]) {
            expect(isCol('ancestryParent', d, t)).toBe(true);
            expect(isCol('ancestryRoot', d, t)).toBe(false);
        }
    });

    it('shows neither on the movies view, which shares the episodes domain', () => {
        // The exact case a domain-only gate got wrong.
        expect(isCol('ancestryParent', 'video', 'movie')).toBe(false);
        expect(isCol('ancestryParent', 'video', 'main')).toBe(false);
    });

    it('shows neither on artists, but keeps their album count', () => {
        expect(isCol('ancestryParent', 'music', 'artist')).toBe(false);
        expect(isCol('children', 'music', 'artist')).toBe(true);
    });
});

describe('defaultSortForType', () => {
    it('groups tracks and episodes by their hierarchy', () => {
        expect(defaultSortForType('track')).toEqual({ sort: 'hierarchy', order: 'asc' });
        expect(defaultSortForType('episode')).toEqual({ sort: 'hierarchy', order: 'asc' });
    });

    it('groups albums by artist', () => {
        expect(defaultSortForType('album')).toEqual({ sort: 'artist', order: 'asc' });
    });

    it('keeps artists alphabetical', () => {
        // Artist rows have NULL ancestry: a hierarchy sort here would collapse
        // to the id tiebreak and render the landing view in arbitrary order.
        expect(defaultSortForType('artist')).toEqual({ sort: 'title', order: 'asc' });
    });

    it('groups seasons by their hierarchy', () => {
        // Was 'title', while ancestrySortKeyFor('season') already said
        // 'hierarchy' — and the consistency test below excluded 'season' so the
        // disagreement never surfaced. A flat A-Z list of "Season 1" repeated
        // once per show is the pathology the per-type defaults exist to remove;
        // namedOrder()'s isTvOnly is true for a season-only type set, so
        // 'hierarchy' groups by series_title then season_number.
        expect(defaultSortForType('season')).toEqual({ sort: 'hierarchy', order: 'asc' });
    });

    it('keeps every other view alphabetical', () => {
        for (const t of ['main', 'movie', 'tv', 'audiobook', 'all', 'other_all']) {
            expect(defaultSortForType(t)).toEqual({ sort: 'title', order: 'asc' });
        }
    });

    it('never returns a sort key the server would reject', () => {
        // VALID_SORT_COLS is IMPORTED, not re-typed: it used to live as a local
        // `const` inside `load` in +page.server.ts, which a route file cannot
        // export, so this list was a hand-copy that could drift out of sync
        // silently — the whitelist would then be asserted against itself.
        const valid = new Set<string>(VALID_SORT_COLS);
        for (const t of ['track', 'episode', 'season', 'album', 'artist', 'main', 'all']) {
            expect(valid.has(defaultSortForType(t).sort)).toBe(true);
        }
    });
});

describe('resolveSortUrlParam', () => {
    describe('rule A — an explicit value is always encoded', () => {
        // Revert-check: buildUrl() used to STRIP `sort`/`order` whenever they
        // equaled the single OLD global default ('title'/'asc'). The default is
        // per-type now, so an omitted param means something different on
        // Tracks/Episodes/Seasons/Albums — stripping 'title' there reroutes the
        // view back to its grouping and the Title header goes inert. If that
        // optimisation ever returns, these fail.
        it('encodes a value that matches the old global default', () => {
            expect(resolveSortUrlParam('title', false)).toEqual({ action: 'set', value: 'title' });
            expect(resolveSortUrlParam('asc', false)).toEqual({ action: 'set', value: 'asc' });
        });

        it('encodes any other explicit value too', () => {
            expect(resolveSortUrlParam('hierarchy', false)).toEqual({
                action: 'set',
                value: 'hierarchy',
            });
            expect(resolveSortUrlParam('desc', false)).toEqual({ action: 'set', value: 'desc' });
        });

        it('deletes an explicitly empty value', () => {
            expect(resolveSortUrlParam('', false)).toEqual({ action: 'delete' });
        });

        it('leaves an unrequested param alone on a same-view navigation', () => {
            // Paging, searching and filter toggles must preserve the sort the
            // operator picked. 'delete' here would silently reset it on every
            // page-2 click; 'set' is impossible with nothing to set.
            expect(resolveSortUrlParam(undefined, false)).toEqual({ action: 'keep' });
        });
    });

    describe('rule B — a view change deletes them', () => {
        // Untested entirely before this. The failure it guards: a stale `sort`
        // rides from the view being LEFT into one where its column may not even
        // be rendered, AND gets persisted (sort/order are in
        // PERSISTED_FILTER_PARAMS). `sort=title` clicked under Tracks lands on
        // Episodes and renders 49,022 rows flat alphabetical for good;
        // `sort=year` carried onto `type=artist` collapses to the mi.id
        // tiebreak with the Year header hidden, so nothing indicates it and
        // nothing can undo it.
        it('deletes an unrequested sort when the view changes', () => {
            // The real shape of a domain/type switch: buildUrl({ type }) passes
            // no sort at all, and the CURRENT url still carries the old one.
            expect(resolveSortUrlParam(undefined, true)).toEqual({ action: 'delete' });
        });

        it('deletes an explicitly requested value too — rule B outranks rule A', () => {
            expect(resolveSortUrlParam('title', true)).toEqual({ action: 'delete' });
            expect(resolveSortUrlParam('hierarchy', true)).toEqual({ action: 'delete' });
        });
    });
});

describe('ancestrySortKeyFor', () => {
    // Regression guard for the wave's actual defect: NOTHING in +page.svelte
    // emitted `sort=hierarchy` or `sort=artist`, so the named sorts were
    // reachable only as a per-type default. One header click and the operator
    // could never get the grouping back.
    it('gives every grouped view a reachable key', () => {
        expect(ancestrySortKeyFor('music', 'track')).toBe('hierarchy');
        expect(ancestrySortKeyFor('video', 'episode')).toBe('hierarchy');
        expect(ancestrySortKeyFor('video', 'season')).toBe('hierarchy');
        expect(ancestrySortKeyFor('music', 'music')).toBe('hierarchy');
        expect(ancestrySortKeyFor('music', 'album')).toBe('artist');
    });

    it('matches the per-type default wherever one exists', () => {
        // A header landing on a different key than the view's own default would
        // make the default look un-selected the moment the page loads.
        //
        // 'season' is IN this loop. It was excluded, which is the only reason
        // defaultSortForType('season')='title' could contradict
        // ancestrySortKeyFor('season')='hierarchy' for as long as it did. Do not
        // narrow this list again to make a failure go away — the failure IS the
        // finding.
        for (const t of ['track', 'episode', 'album', 'season']) {
            expect(ancestrySortKeyFor(inferDomain(t), t)).toBe(defaultSortForType(t).sort);
        }
    });

    it('offers no key where there are no ancestry columns', () => {
        expect(ancestrySortKeyFor('video', 'movie')).toBeNull();
        expect(ancestrySortKeyFor('video', 'main')).toBeNull();
        expect(ancestrySortKeyFor('music', 'artist')).toBeNull();
        expect(ancestrySortKeyFor('audiobook', 'audiobook')).toBeNull();
    });

    it('offers no key on the mixed Everything view, which has no single hierarchy', () => {
        // `type=all` DOES render ancestry columns (generic parent/root labels),
        // so this is not implied by the previous case: namedOrder() sees a type
        // set spanning both the TV and music hierarchies and falls through to
        // plain title order, so a clickable header would promise a grouping the
        // query cannot deliver.
        expect(columnAppliesTo('ancestryParent', 'everything', 'all')).toBe(true);
        expect(ancestrySortKeyFor('everything', 'all')).toBeNull();
    });

    it('only ever names a sort key the server whitelists', () => {
        const valid = new Set<string>(VALID_SORT_COLS);
        for (const t of ['track', 'episode', 'season', 'album', 'music', 'all', 'main']) {
            const key = ancestrySortKeyFor(inferDomain(t), t);
            if (key !== null) expect(valid.has(key)).toBe(true);
        }
    });
});

describe('isGroupingSort', () => {
    it('marks the multi-column named sorts as groupings', () => {
        // These must not get a direction toggle: namedOrder() emits a fixed
        // ascending ORDER BY and ignores sortDir, so a second click flipping to
        // `desc` would change the URL and re-render an identical table.
        expect(isGroupingSort('hierarchy')).toBe(true);
        expect(isGroupingSort('artist')).toBe(true);
    });

    it('leaves the plain btree columns toggleable', () => {
        for (const c of ['title', 'year', 'created_at', 'updated_at']) {
            expect(isGroupingSort(c)).toBe(false);
        }
    });

    it('covers every sort key the ancestry headers can emit', () => {
        // The headers are the only entry point for these keys, and they render
        // no toggle affordance — so anything reachable through them must be
        // recognised here, or sortUrl would start flipping direction again.
        for (const t of ['track', 'episode', 'season', 'album', 'music']) {
            const key = ancestrySortKeyFor(inferDomain(t), t);
            expect(key).not.toBeNull();
            expect(isGroupingSort(key!)).toBe(true);
        }
    });
});

/**
 * The invariant that keeps failing.
 *
 * Twice now a `media_type` has been unreachable in the admin browser under ANY
 * filter — `audiobook`, then `extra` — and neither was a decision. Both were
 * simply never classified, and an omission is invisible: the Everything view
 * renders happily, just without those rows. Nothing failed until an operator
 * noticed a count that could not be reconciled with a list.
 *
 * An exhaustive partition converts that silence into a test failure the moment
 * a new type is added to the vocabulary. It still hand-maintains a list, but it
 * fails LOUDLY on the case that has actually bitten, which "derive it from the
 * writers" cannot do — "can own a `media_files` row" is a property of every
 * `attachFileToItem` call site and is not encoded anywhere a test can read.
 */
describe('browsable/non-browsable partition', () => {
    it('classifies every internal media type as exactly one of the two', () => {
        const browsable = new Set(ALL_BROWSABLE_TYPES);
        const nonBrowsable = new Set(NON_BROWSABLE_TYPES);
        const unclassified = INTERNAL_MEDIA_TYPES.filter(
            (t) => !browsable.has(t) && !nonBrowsable.has(t),
        );
        // A new media type lands here. Decide which side it belongs on and say
        // why in the list's comment — do NOT delete this assertion.
        expect(unclassified).toEqual([]);
    });

    it('puts no type on both sides', () => {
        const nonBrowsable = new Set(NON_BROWSABLE_TYPES);
        expect(ALL_BROWSABLE_TYPES.filter((t) => nonBrowsable.has(t))).toEqual([]);
    });

    it('names no type the database cannot store', () => {
        const known = new Set<string>(INTERNAL_MEDIA_TYPES);
        for (const t of [...ALL_BROWSABLE_TYPES, ...NON_BROWSABLE_TYPES]) {
            expect(known.has(t)).toBe(true);
        }
    });

    // The regression that opened this: `extra` rows own real `media_files` rows
    // and can carry a real `truncated_video`, but no `?type=` value could list
    // one. `all` is the widest scope the browser offers, so it is where the
    // check belongs.
    it('lets the Everything view reach an extra', () => {
        expect(resolveTypes('all', 'everything')).toContain('extra');
    });
});

/**
 * The single-value `?filter=` param.
 *
 * The mapping is unit-tested rather than only exercised through the load
 * because the value strings are a contract with THREE other places: the
 * server-side predicates (`music-hygiene.queries.ts`), the deep links
 * (`buildMusicHygieneLink`) and the chip label map in `+page.svelte`. A typo in
 * any one of them produces an unfiltered list under a filtered heading, and
 * nothing anywhere throws.
 */
describe('resolveBrowserFilter', () => {
    it('maps file-issues to the file-issues flag and nothing else', () => {
        expect(resolveBrowserFilter('file-issues')).toEqual({
            fileIssues: true,
            musicHygiene: null,
        });
    });

    it('maps every music-hygiene finding to itself, and not to file-issues', () => {
        for (const finding of MUSIC_HYGIENE_FINDINGS) {
            expect(resolveBrowserFilter(finding), finding).toEqual({
                fileIssues: false,
                musicHygiene: finding,
            });
        }
    });

    it('degrades an absent or unknown value to no filter rather than throwing', () => {
        for (const raw of [null, undefined, '', 'music-something-from-a-newer-build', 'x']) {
            expect(resolveBrowserFilter(raw)).toEqual({ fileIssues: false, musicHygiene: null });
        }
    });

    it('accepts every value it advertises', () => {
        for (const value of MEDIA_BROWSER_FILTER_VALUES) {
            const resolved = resolveBrowserFilter(value);
            expect(resolved.fileIssues || resolved.musicHygiene !== null, value).toBe(true);
        }
    });

    // The values are `?filter=` values verbatim. A space or an uppercase letter
    // would survive a URL round-trip but read badly and invite a hand-typed
    // near-miss; kebab-case is the shape `file-issues` set.
    it('keeps every filter value URL-safe kebab-case', () => {
        for (const value of MEDIA_BROWSER_FILTER_VALUES) {
            expect(value, value).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
            expect(encodeURIComponent(value)).toBe(value);
        }
    });
});

/**
 * The seam between a finding's deep link and the count taken for its badge.
 *
 * `countMusicHygieneFinding` scopes itself with `[MUSIC_HYGIENE_VIEW[f].type]`
 * while the browser resolves the SAME link's `?type=` through `resolveTypes`.
 * If those two disagree for any finding, the badge counts one population and
 * the page lists another — the defect this browser has already shipped twice.
 * Assert it at the seam rather than trusting that both sides say "track".
 */
describe('music-hygiene deep links land where their counts are taken', () => {
    it('resolves each finding view to exactly its own single media type', () => {
        for (const finding of MUSIC_HYGIENE_FINDINGS) {
            const view = MUSIC_HYGIENE_VIEW[finding];
            expect(resolveTypes(view.type, view.domain), finding).toEqual([view.type]);
        }
    });

    it('pairs each finding domain with the type the browser would default to', () => {
        for (const finding of MUSIC_HYGIENE_FINDINGS) {
            const view = MUSIC_HYGIENE_VIEW[finding];
            // Not `defaultTypeForDomain` — the link always names its type. What
            // must hold is the inverse: the named type must infer back to the
            // named domain, or the page renders another domain's filter chips
            // and stats tiles over this list.
            expect(inferDomain(view.type), finding).toBe(view.domain);
        }
    });

    it('builds a link carrying all three params, for every finding', () => {
        for (const finding of MUSIC_HYGIENE_FINDINGS) {
            const params = new URL(buildMusicHygieneLink(finding), 'https://example.invalid')
                .searchParams;
            expect(params.get('filter'), finding).toBe(finding);
            expect(params.get('domain'), finding).toBe(MUSIC_HYGIENE_VIEW[finding].domain);
            expect(params.get('type'), finding).toBe(MUSIC_HYGIENE_VIEW[finding].type);
            // The link must round-trip through the parser it targets.
            expect(resolveBrowserFilter(params.get('filter')).musicHygiene).toBe(finding);
        }
    });

    it('marks exactly one finding as a heuristic, and it is the conjunction one', () => {
        const heuristics = MUSIC_HYGIENE_FINDINGS.filter(isHeuristicMusicHygieneFinding);
        // A fifth finding added without a decision lands here. Classify it —
        // an unmarked heuristic renders as a defect list.
        expect(heuristics).toEqual(['music-artist-unsplit']);
    });
});
