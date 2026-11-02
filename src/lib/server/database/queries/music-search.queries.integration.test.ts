// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for searchMusic
 *
 * Covers trigram typo tolerance, parent/grandparent chain expansion,
 * deduplication, and no-match semantics.
 *
 * Runs against a real PostgreSQL database (lumastra_tests) via the preprod
 * tunnel — no local PG required. Execute with:
 *   npm run test:integration -- src/lib/server/database/queries/music-search.queries.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack as insertTrackRow,
} from '../../../../../tests/integration/fixtures/index.js';
import { searchMusic, searchAdminQuickNav } from './search.queries.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';
import { SearchService } from '../../services/search.service.js';
import { buildMusicCardItem } from '$lib/utils/mapMusicTrackToItem';

// =============================================================================
// Helpers
// =============================================================================

import { recomputeHasFiles } from './media-files.queries.js';

async function insertTestTrack(
    sql: postgres.Sql,
    track: Parameters<typeof insertTrackRow>[1],
): Promise<string> {
    const id = await insertTrackRow(sql, track);
    await recomputeHasFiles(sql, id);
    return id;
}

/** Default access boundary — admin / no restriction mode. */
const OPEN_ACCESS = unrestrictedAccess();
/** Default query-shaping options. */
const OPEN_OPTS = { offset: 0 } as const;

/**
 * Seed a full artist → album → track chain and return the three IDs.
 * Title overrides are supplied by the caller so each test controls what is
 * searchable without risk of cross-test FTS collisions.
 */
async function seedMusicChain(
    sql: postgres.Sql,
    artistTitle: string,
    albumTitle: string,
    trackTitle: string,
): Promise<{ artistId: string; albumId: string; trackId: string }> {
    const artist = createTestArtist({ title: artistTitle });
    await insertTestArtist(sql, artist);

    const album = createTestAlbum(artist.id, { title: albumTitle });
    await insertTestAlbum(sql, album);

    const track = createTestTrack(album.id, 1, { title: trackTitle });
    await insertTestTrack(sql, track); // also inserts media_files + marks has_files=true

    return { artistId: artist.id, albumId: album.id, trackId: track.id };
}

// =============================================================================
// Tests
// =============================================================================

describe('searchMusic', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    it('finds canonical volume tokens through music, universal search and suggestions', async () => {
        const albums = new Map<string, string>();
        for (const suffix of ['Vol.100', 'Vol17', 'Vol. 17', 'Vol. 10', 'Vol.003']) {
            const ids = await seedMusicChain(
                sql,
                `Invented Nocturnal Ensemble ${suffix}`,
                `Night Drive Sessions ${suffix}`,
                `Invented Interlude ${suffix}`,
            );
            await sql`UPDATE media_items SET has_files = true WHERE id = ${ids.albumId}`;
            albums.set(suffix, ids.albumId);
        }
        const variants = [
            'Vol.100',
            'Vol. 100',
            'Vol 100',
            'Volume 100',
            'Vol100',
            'vol.100',
            '100',
        ];
        const queries = variants.map((suffix) => `Night Drive Sessions ${suffix}`);
        queries.push('night.drive-sessions_[volume,100]');
        const sources = {
            movies: false,
            series: false,
            episodes: false,
            music: true,
            books: false,
            audiobooks: false,
            requests: false,
            channels: false,
            nonEntTypes: [],
        } as const;
        for (const q of queries) {
            const rows = await searchMusic(sql, q, 50, OPEN_ACCESS);
            expect(
                rows.map((r) => r.id),
                q,
            ).toContain(albums.get('Vol.100'));
            const universal = await SearchService.searchMusicRows(
                {
                    sql,
                    q,
                    window: 50,
                    offset: 0,
                    limit: 50,
                    useFulltext: false,
                    deniedGroupIds: null,
                    ageRating: null,
                    showUnavailableMedia: false,
                    liveTvAllowed: false,
                    surface: 'internal',
                    sources,
                },
                OPEN_ACCESS,
            );
            expect(
                universal.map((r) => r.title),
                q,
            ).toContain('Night Drive Sessions Vol.100');
            const suggestions = await SearchService.suggestFanOut({
                sql,
                q,
                window: 50,
                limit: 50,
                showUnavailableMedia: false,
                surface: 'internal',
                sources,
                deniedGroupIds: null,
                ageRating: { maxAgeRating: null, allowUnrated: true },
            });
            expect(
                suggestions.map((r) => r.title),
                q,
            ).toContain('Night Drive Sessions Vol.100');
        }
        const seventeens = await searchMusic(sql, 'night drive sessions 17', 50, OPEN_ACCESS);
        expect(seventeens.map((r) => r.id)).toEqual(
            expect.arrayContaining([albums.get('Vol17'), albums.get('Vol. 17')]),
        );
        for (const q of ['night drive sessions 3', 'night drive sessions vol 03', '3']) {
            expect(
                (await searchMusic(sql, q, 50, OPEN_ACCESS)).map((r) => r.id),
                q,
            ).toContain(albums.get('Vol.003'));
        }
        const ranked = await searchMusic(sql, 'night drive sessions 10', 50, OPEN_ACCESS);
        const exact = ranked.find((r) => r.id === albums.get('Vol. 10'));
        expect(exact).toBeDefined();
        const prefix = ranked.find((r) => r.id === albums.get('Vol.100'));
        if (prefix) expect(Number(exact!.rank)).toBeGreaterThan(Number(prefix.rank));
        expect(ranked.find((r) => r.media_type === 'album')?.id).toBe(albums.get('Vol. 10'));

        // SQL applies the same token rules; immutable_unaccent additionally folds accents.
        const [normalized] = await sql<{ value: string }[]>`
            SELECT music_search_normalize('Nïght.Drive-Sessions_[Volume,003]') AS value
        `;
        expect(normalized.value).toBe('night drive sessions 3');
        // Expression index must stay current when titles are edited (no backfill/trigger needed).
        await sql`UPDATE media_items SET title = 'Night Drive Sessions Vol.004'
            WHERE id = ${albums.get('Vol.003')!}`;
        expect(
            (await searchMusic(sql, 'night drive sessions 4', 50, OPEN_ACCESS)).map((r) => r.id),
        ).toContain(albums.get('Vol.003'));
    });

    it('treats empty canonical credits as absent and falls back to the legacy tag', async () => {
        const { trackId } = await seedMusicChain(
            sql,
            'Legacy Parent',
            'Old Album',
            'Canonical Empty Song',
        );
        await sql`UPDATE media_items SET metadata_locked = true,
            custom_metadata = '{"artist":"Stale Performer","track_artist_credits":[]}'::jsonb
            WHERE id = ${trackId}::uuid`;
        const results = await searchMusic(sql, 'Canonical Empty Song', 50, OPEN_ACCESS, OPEN_OPTS);
        const track = results.find((row) => row.id === trackId);
        expect(track).toBeDefined();
        expect(track?.artist_name).toBe('Stale Performer');
        if (!track) throw new Error('Expected the canonical empty track in search');
        const result = SearchService.mapMusicRow(track, 'internal');
        if (!result) throw new Error('Expected a mapped music search result');
        const card = buildMusicCardItem({
            id: result.id,
            mediaType: 'track',
            title: result.title,
            artists: result.artists,
            remixerArtists: result.remixerArtists,
            subtitle: result.artist,
            clickData: { artistId: result.artistId },
        });
        expect(card.subtitle).toBe('Stale Performer');
    });

    // -------------------------------------------------------------------------
    // 1. FTS direct + parent-chain expansion
    // -------------------------------------------------------------------------

    it('returns artist, album, and track when querying the artist name (full chain expansion)', async () => {
        const { artistId, albumId, trackId } = await seedMusicChain(
            sql,
            'Queronix',
            'Album Quantum',
            'Song Vortex',
        );

        const results = await searchMusic(sql, 'Queronix', 50, OPEN_ACCESS, OPEN_OPTS);
        const ids = results.map((r) => r.id);

        // Direct FTS hit on artist
        expect(ids).toContain(artistId);
        // Parent expansion: album whose parent matched
        expect(ids).toContain(albumId);
        // Grandparent expansion: track whose grandparent matched
        expect(ids).toContain(trackId);
    });

    it('ranks the direct artist hit above the child album and grandchild track', async () => {
        const { artistId } = await seedMusicChain(sql, 'Queronix', 'Album Quantum', 'Song Vortex');

        const results = await searchMusic(sql, 'Queronix', 50, OPEN_ACCESS, OPEN_OPTS);

        expect(results.length).toBeGreaterThan(0);
        // The direct hit has rank > 1 (ts_rank + 1.0); parent/grandparent hits ≤ 0.8
        expect(results[0].id).toBe(artistId);
        expect(Number(results[0].rank)).toBeGreaterThan(0.8);
    });

    // -------------------------------------------------------------------------
    // 2. Track found by album name (parent) and by artist name (grandparent)
    // -------------------------------------------------------------------------

    it('returns the track when searching the album title (parent match)', async () => {
        const { trackId } = await seedMusicChain(
            sql,
            'ArtistParentTest',
            'AlbumNovaTide',
            'Track One',
        );

        const results = await searchMusic(sql, 'AlbumNovaTide', 50, OPEN_ACCESS, OPEN_OPTS);
        const ids = results.map((r) => r.id);

        expect(ids).toContain(trackId);
    });

    it('returns the track when searching the artist title (grandparent match)', async () => {
        const { trackId } = await seedMusicChain(
            sql,
            'ArtistGrandparentTest',
            'Album Flux',
            'Track Two',
        );

        const results = await searchMusic(sql, 'ArtistGrandparentTest', 50, OPEN_ACCESS, OPEN_OPTS);
        const ids = results.map((r) => r.id);

        expect(ids).toContain(trackId);
    });

    // -------------------------------------------------------------------------
    // 3. TRIGRAM typo tolerance (the new capability from A3)
    // -------------------------------------------------------------------------

    it('finds a track via trigram when the query has a 1-char deletion typo', async () => {
        // 'yesterdy' is NOT a valid FTS prefix of 'Yesterday' (it's a deletion,
        // not a truncation), so this only matches via trigram similarity.
        const { trackId } = await seedMusicChain(
            sql,
            'Classic Hits Band',
            'Golden Oldies Album',
            'Yesterday',
        );

        const results = await searchMusic(sql, 'yesterdy', 50, OPEN_ACCESS, OPEN_OPTS);
        const ids = results.map((r) => r.id);

        expect(ids).toContain(trackId);
    });

    // -------------------------------------------------------------------------
    // 4. No duplicate rows when a query matches at multiple hierarchy levels
    // -------------------------------------------------------------------------

    it('returns each media item at most once even when it matches at multiple levels', async () => {
        // Seed an artist + album + track whose titles all share a distinctive token
        // "Zyrex" so a search for "Zyrex" matches all three directly via FTS.
        await seedMusicChain(sql, 'Zyrex Artist', 'Zyrex Album', 'Zyrex Track');

        const results = await searchMusic(sql, 'Zyrex', 50, OPEN_ACCESS, OPEN_OPTS);
        const ids = results.map((r) => r.id);

        // No duplicate IDs
        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids).size).toBe(ids.length);
    });

    // -------------------------------------------------------------------------
    // 5. No-match returns empty array
    // -------------------------------------------------------------------------

    it('returns an empty array for a query that matches nothing', async () => {
        await seedMusicChain(sql, 'Mundane Artist', 'Mundane Album', 'Mundane Track');

        const results = await searchMusic(sql, 'Xzqwvpklmnoexist99', 50, OPEN_ACCESS, OPEN_OPTS);

        expect(results).toHaveLength(0);
    });

    // -------------------------------------------------------------------------
    // 6. Various Artists exclusion is opt-in via `excludeVariousArtists`
    //    (flag-driven, not name-driven). Subsonic/Jellyfin compat callers omit
    //    the option and must keep seeing the VA row; user-facing search opts in.
    // -------------------------------------------------------------------------

    it('keeps a flagged VA artist visible by default (compat: no excludeVariousArtists option)', async () => {
        const va = createTestArtist({ title: 'Zqflag Various Artists Bucket' });
        await insertTestArtist(sql, va);
        const playableAlbum = createTestAlbum(va.id);
        await insertTestAlbum(sql, playableAlbum);
        await insertTestTrack(sql, createTestTrack(playableAlbum.id, 1));
        await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${va.id}::uuid`;

        const results = await searchMusic(
            sql,
            'Zqflag Various Artists Bucket',
            50,
            OPEN_ACCESS,
            OPEN_OPTS,
        );

        expect(results.some((r) => r.id === va.id)).toBe(true);
    });

    it('excludes an artist flagged is_various_artists when excludeVariousArtists is true', async () => {
        const va = createTestArtist({ title: 'Zqflag Various Artists Bucket' });
        await insertTestArtist(sql, va);
        const playableAlbum = createTestAlbum(va.id);
        await insertTestAlbum(sql, playableAlbum);
        await insertTestTrack(sql, createTestTrack(playableAlbum.id, 1));
        await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${va.id}::uuid`;

        const results = await searchMusic(sql, 'Zqflag Various Artists Bucket', 50, OPEN_ACCESS, {
            ...OPEN_OPTS,
            excludeVariousArtists: true,
        });

        expect(results.some((r) => r.id === va.id)).toBe(false);
    });

    // -------------------------------------------------------------------------
    // 7. Exact/prefix boost + container tiebreak survive LIMIT crowding.
    //    Regression: "sum" did not find the artist "Sum 41" — every direct FTS
    //    hit tied at ts_rank + 1.0, the alphabetical tiebreak put "A… Summer …"
    //    tracks first, and the artist was truncated away by LIMIT.
    // -------------------------------------------------------------------------

    it('ranks a prefix-matching artist above same-rank mid-title track hits (survives small LIMIT)', async () => {
        const sum41 = createTestArtist({ title: 'Sum 41' });
        await insertTestArtist(sql, sum41);
        const playableAlbum = createTestAlbum(sum41.id);
        await insertTestAlbum(sql, playableAlbum);
        await insertTestTrack(sql, createTestTrack(playableAlbum.id, 1));

        // Filler chain whose tracks all FTS-match "sum:*" via a mid-title word
        // and sort alphabetically before "Sum 41".
        const filler = createTestArtist({ title: 'Crowd Filler Band' });
        await insertTestArtist(sql, filler);
        const album = createTestAlbum(filler.id, { title: 'Crowd Filler Album' });
        await insertTestAlbum(sql, album);
        for (let i = 1; i <= 12; i++) {
            const track = createTestTrack(album.id, i, {
                title: `Anthem of Summer ${String(i).padStart(2, '0')}`,
            });
            await insertTestTrack(sql, track);
        }

        const results = await searchMusic(sql, 'sum', 5, OPEN_ACCESS, OPEN_OPTS);

        // The artist must be in the window despite 12 alphabetically-earlier
        // same-band track hits, and ranked first (prefix boost + artist tiebreak).
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].id).toBe(sum41.id);
    });

    it('still returns an ordinary artist that is not flagged, with excludeVariousArtists true', async () => {
        const { artistId } = await seedMusicChain(
            sql,
            'Zqflag Ordinary Artist',
            'Ordinary Album',
            'Ordinary Track',
        );

        const results = await searchMusic(sql, 'Zqflag Ordinary Artist', 50, OPEN_ACCESS, {
            ...OPEN_OPTS,
            excludeVariousArtists: true,
        });

        expect(results.some((r) => r.id === artistId)).toBe(true);
    });

    // -------------------------------------------------------------------------
    // playableOnly — file-less (catalog-only) tracks and albums
    // -------------------------------------------------------------------------

    /** A chain whose album and track have no file on disk; the artist too. */
    async function seedFilelessChain(title: string) {
        const ids = await seedMusicChain(
            sql,
            `${title} Artist`,
            `${title} Album`,
            `${title} Track`,
        );
        await sql`
            UPDATE media_items SET has_files = false
            WHERE id IN (${ids.artistId}, ${ids.albumId}, ${ids.trackId})
        `;
        return ids;
    }

    it('hides file-less tracks and albums by default on every search surface', async () => {
        const { albumId, trackId } = await seedFilelessChain('Zqnofile');

        const results = await searchMusic(sql, 'Zqnofile', 50, OPEN_ACCESS, OPEN_OPTS);
        const ids = results.map((r) => r.id);

        expect(ids).not.toContain(albumId);
        expect(ids).not.toContain(trackId);
    });

    it('drops file-less tracks and albums with playableOnly, but keeps the artist', async () => {
        const fileless = await seedFilelessChain('Zqnofile');
        const playable = await seedMusicChain(
            sql,
            'Zqnofile Live',
            'Zqnofile Tour',
            'Zqnofile Encore',
        );
        // insertTestTrack only flags the track; the scanner also carries
        // has_files up to the album, which is what playableOnly reads.
        await sql`UPDATE media_items SET has_files = true WHERE id = ${playable.albumId}`;

        const results = await searchMusic(sql, 'Zqnofile', 50, OPEN_ACCESS, {
            ...OPEN_OPTS,
            playableOnly: true,
        });
        const ids = results.map((r) => r.id);

        expect(ids).not.toContain(fileless.albumId);
        expect(ids).not.toContain(fileless.trackId);
        // A credit-only artist has no files of its own and is still a real hit.
        expect(ids).toContain(fileless.artistId);
        expect(ids).toContain(playable.albumId);
        expect(ids).toContain(playable.trackId);
    });

    // -------------------------------------------------------------------------
    // mediaTypes — one section at a time
    // -------------------------------------------------------------------------

    it('mediaTypes [track] returns only tracks, still found through the artist name', async () => {
        const { trackId } = await seedMusicChain(sql, 'Zqtyped', 'Zqtyped Hits', 'Moonlight');

        const results = await searchMusic(sql, 'Zqtyped', 50, OPEN_ACCESS, {
            ...OPEN_OPTS,
            mediaTypes: ['track'],
        });

        // "Moonlight" only matches through its grandparent; restricting the
        // returned type must not restrict the discovery chain.
        expect(results.map((r) => r.id)).toEqual([trackId]);
        // Discovery follows the album artist, but attribution follows the
        // track's own ARTIST tag (the fixture defaults to Test Artist).
        expect(results[0].artist_name).toBe('Test Artist');
    });

    it('mediaTypes [album, artist] drops the tracks', async () => {
        const { artistId, albumId } = await seedMusicChain(
            sql,
            'Zqsections',
            'Zqsections Live',
            'Zqsections Opener',
        );

        const results = await searchMusic(sql, 'Zqsections', 50, OPEN_ACCESS, {
            ...OPEN_OPTS,
            mediaTypes: ['album', 'artist'],
        });

        expect(results.map((r) => r.id).sort()).toEqual([artistId, albumId].sort());
    });

    // -------------------------------------------------------------------------
    // Popularity tiebreak
    // -------------------------------------------------------------------------

    it('orders same-tier tracks by popularity, never lifting one above the album', async () => {
        const artist = createTestArtist({ title: 'Zqpopular' });
        await insertTestArtist(sql, artist);
        const album = createTestAlbum(artist.id, { title: 'Greatest' });
        await insertTestAlbum(sql, album);
        // A-Z would put "Alpha" first; the popular "Omega" must win the tie.
        const alpha = createTestTrack(album.id, 1, { title: 'Alpha' });
        const omega = createTestTrack(album.id, 2, { title: 'Omega' });
        await insertTestTrack(sql, alpha);
        await insertTestTrack(sql, omega);
        await sql`
            INSERT INTO media_popularity (media_id, source, score_context, normalized_score)
            VALUES (${omega.id}, 'lastfm', 'track_in_artist', 1.0),
                   (${alpha.id}, 'lastfm', 'track_in_artist', 0.1)
        `;

        const results = await searchMusic(sql, 'Zqpopular', 50, OPEN_ACCESS, OPEN_OPTS);
        const ids = results.map((r) => r.id);

        expect(ids).toEqual([artist.id, album.id, omega.id, alpha.id]);
    });

    it('offset pages over same-titled tracks are disjoint and complete', async () => {
        const artist = createTestArtist({ title: 'Zqpaged' });
        await insertTestArtist(sql, artist);
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const album = createTestAlbum(artist.id, { title: `Edition ${i}` });
            await insertTestAlbum(sql, album);
            // One song on five albums: rank, type and title all tie.
            const track = createTestTrack(album.id, 1, { title: 'Same Song' });
            await insertTestTrack(sql, track);
            ids.push(track.id);
        }
        const page = (offset: number) =>
            searchMusic(sql, 'Zqpaged', 2, OPEN_ACCESS, { offset, mediaTypes: ['track'] });

        const pages = [await page(0), await page(2), await page(4)].map((p) => p.map((r) => r.id));

        expect(pages.flat().sort()).toEqual([...ids].sort());
        expect(new Set(pages.flat()).size).toBe(5);
    });

    it('popularity never lifts a credited track over a closer tier (credit 0.78 vs album 0.80)', async () => {
        // Album-title (parent) match: rank 0.80, no popularity.
        const { trackId: parentHit } = await seedMusicChain(
            sql,
            'Someone Else',
            'Zqtier',
            'Opening',
        );
        // Credit-only match: rank 0.78, maximum popularity.
        const { trackId: creditHit } = await seedMusicChain(
            sql,
            'Another Act',
            'Unrelated',
            'Closing',
        );
        await sql`
            INSERT INTO media_people (media_id, name, role, source)
            VALUES (${creditHit}, 'Zqtier', 'artist', 'local')
        `;
        await sql`
            INSERT INTO media_popularity (media_id, source, score_context, normalized_score)
            VALUES (${creditHit}, 'lastfm', 'track_in_artist', 1.0)
        `;

        const results = await searchMusic(sql, 'Zqtier', 50, OPEN_ACCESS, {
            ...OPEN_OPTS,
            mediaTypes: ['track'],
        });

        expect(results.map((r) => r.id)).toEqual([parentHit, creditHit]);
    });
});

// =============================================================================
// searchAdminQuickNav — admin quick-nav relevance ordering
// =============================================================================

describe('searchAdminQuickNav', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    it('ranks a prefix-matching item above same-band mid-title hits despite a small LIMIT', async () => {
        // Regression guard for the type-bucket + alphabetical ordering that
        // starved exact/prefix matches (same failure class as the searchMusic
        // "sum" → "Sum 41" bug).
        const sum41 = createTestArtist({ title: 'Sum 41' });
        await insertTestArtist(sql, sum41);

        const filler = createTestArtist({ title: 'Crowd Filler Band' });
        await insertTestArtist(sql, filler);
        const album = createTestAlbum(filler.id, { title: 'Crowd Filler Album' });
        await insertTestAlbum(sql, album);
        for (let i = 1; i <= 12; i++) {
            const track = createTestTrack(album.id, i, {
                title: `Anthem of Summer ${String(i).padStart(2, '0')}`,
            });
            await insertTestTrack(sql, track);
        }

        const results = await searchAdminQuickNav(sql, 'sum', unrestrictedAccess(), 5);

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].id).toBe(sum41.id);
        // Ranks arrive descending
        const ranks = results.map((r) => Number(r.rank));
        expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    });

    it('returns parent/child context rows for a matched artist', async () => {
        const artist = createTestArtist({ title: 'Quicknav Artist' });
        await insertTestArtist(sql, artist);
        const album = createTestAlbum(artist.id, { title: 'Quicknav Album' });
        await insertTestAlbum(sql, album);
        const track = createTestTrack(album.id, 1, { title: 'Quicknav Track' });
        await insertTestTrack(sql, track);

        const results = await searchAdminQuickNav(sql, 'Quicknav Artist', unrestrictedAccess());
        const ids = results.map((r) => r.id);

        // Chain expansion: direct artist hit + parent/grandparent expansion
        expect(ids).toContain(artist.id);
        expect(ids).toContain(album.id);
        expect(ids).toContain(track.id);
        // Direct hit outranks descendants
        expect(results[0].id).toBe(artist.id);
        const trackRow = results.find((r) => r.id === track.id);
        expect(trackRow?.grandparent_title).toBe('Quicknav Artist');
    });

    it('returns an empty array for a query that matches nothing', async () => {
        const results = await searchAdminQuickNav(sql, 'Xzqwvpklmnoexist99', unrestrictedAccess());
        expect(results).toHaveLength(0);
    });
});
