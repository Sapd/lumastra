// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/j` `/Items` list filters from cloud-parity brief 09 (ExcludeItemIds,
 * NameLessThan / NameStartsWithOrGreater, OfficialRatings, Tags, audio and
 * subtitle languages, ImageTypes, AlbumIds / AlbumArtistIds, HasParentalRating
 * and MaxOfficialRating) against real rows, each also under an access
 * boundary where the filter could otherwise reach past it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { browseMediaItems, type BrowseItemsOptions } from './jellyfin-browse.queries.js';
import { restrictedAccess, unrestrictedAccess } from './builders/media-access-boundary.js';
import { getJellyfinFilterValues } from './jellyfin-filters.queries.js';

let sql: postgres.Sql;
let userId: UserId;

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, [
        'user_media_state',
        'provider_metadata',
        'media_artwork',
        'external_subtitle_files',
        'media_streams',
        'media_file_items',
        'media_files',
        'external_ids',
        'media_items',
    ]);
    userId = toUserId(randomUUID());
    await ensureTestUser(sql, userId);
});

interface Seed {
    title: string;
    type?: string;
    parentId?: string | null;
    sortTitle?: string;
    ageRating?: number | null;
    metadata?: Record<string, unknown>;
    audio?: (string | null)[];
    subtitles?: string[];
    sidecarSubtitles?: string[];
}

async function item(seed: Seed): Promise<string> {
    const type = seed.type ?? 'movie';
    const leaf = ['movie', 'episode', 'track'].includes(type);
    // Music folders carry has_files like the scanner sets it (the browse
    // query lists non-video rows only with files).
    const hasFiles = leaf || type === 'album' || type === 'artist';
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, sort_title, media_type, status, parent_id, has_files, age_rating)
        VALUES (${seed.title}, ${seed.sortTitle ?? seed.title.toLowerCase()}, ${type}, 'active',
                ${seed.parentId ?? null}, ${hasFiles}, ${seed.ageRating ?? null})
        RETURNING id`;
    if (seed.metadata) {
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
                  VALUES (${row.id}::uuid, 'tmdb', ${sql.json(seed.metadata as never)})`;
    }
    if (leaf) {
        const [f] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, created_at, updated_at)
            VALUES (${`/wave2/${row.id}.mkv`}, NOW(), NOW()) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                  VALUES (${f.id}::uuid, ${row.id}::uuid, true)`;
        let index = 0;
        for (const lang of seed.audio ?? []) {
            await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, language, is_default, is_forced)
                      VALUES (${f.id}::uuid, 'audio', ${index++}, ${lang}, false, false)`;
        }
        for (const lang of seed.subtitles ?? []) {
            await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, language, is_default, is_forced)
                      VALUES (${f.id}::uuid, 'subtitle', ${index++}, ${lang}, false, false)`;
        }
        for (const lang of seed.sidecarSubtitles ?? []) {
            await sql`INSERT INTO external_subtitle_files (file_id, subtitle_path, language, format)
                      VALUES (${f.id}::uuid, ${`/wave2/${row.id}.${lang}.srt`}, ${lang}, 'srt')`;
        }
    }
    return row.id;
}

async function browse(opts: Partial<BrowseItemsOptions>): Promise<string[]> {
    const { rows } = await browseMediaItems(sql, {
        mediaTypes: [],
        parentId: null,
        searchTerm: null,
        genres: [],
        years: [],
        nameStartsWith: null,
        isFavoriteFilter: false,
        isPlayedFilter: false,
        isUnplayedFilter: false,
        enableUserData: false,
        userId,
        idList: [],
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        limit: 50,
        startIndex: 0,
        access: unrestrictedAccess(),
        ...opts,
    });
    return rows.map((r) => r.id as string);
}

describe('ExcludeItemIds', () => {
    it('leaves the named items out', async () => {
        const a = await item({ title: 'Alpha' });
        const b = await item({ title: 'Beta' });
        expect(await browse({ mediaTypes: ['movie'], excludeIds: [a] })).toEqual([b]);
    });
});

describe('NameLessThan / NameStartsWithOrGreater', () => {
    it('cuts the sort-name range like the A–Z jump bar', async () => {
        const one = await item({ title: '1917', sortTitle: '1917' });
        const alpha = await item({ title: 'Alpha' });
        const beta = await item({ title: 'Beta' });
        const gamma = await item({ title: 'Gamma' });
        expect(await browse({ mediaTypes: ['movie'], nameLessThan: 'B' })).toEqual([one, alpha]);
        expect(await browse({ mediaTypes: ['movie'], nameStartsWithOrGreater: 'b' })).toEqual([
            beta,
            gamma,
        ]);
    });
});

describe('NameLessThan / NameStartsWithOrGreater paging', () => {
    it('splits non-ASCII and punctuated titles exactly where SortName orders them', async () => {
        // Stored sort keys are normalized (diacritics folded, leading
        // punctuation and articles stripped); the boundaries must match.
        const hack = await item({ title: '.harbor', sortTitle: 'harbor' });
        const eclair = await item({ title: 'Éclair', sortTitle: 'eclair' });
        const matrix = await item({ title: 'The Lantern', sortTitle: 'lantern' });
        const ubel = await item({ title: 'Übler Wind', sortTitle: 'ubler wind' });
        const all = await browse({ mediaTypes: ['movie'] });
        expect(all).toEqual([eclair, hack, matrix, ubel]);
        for (const boundary of ['Éclair', 'The Lantern', '.harbor', 'Übler Wind', 'É']) {
            const below = await browse({ mediaTypes: ['movie'], nameLessThan: boundary });
            const above = await browse({
                mediaTypes: ['movie'],
                nameStartsWithOrGreater: boundary,
            });
            // No row skipped, none repeated, same order as SortName.
            expect([...below, ...above], boundary).toEqual(all);
        }
        expect(await browse({ mediaTypes: ['movie'], nameLessThan: 'Éclair' })).toEqual([]);
        expect(await browse({ mediaTypes: ['movie'], nameStartsWithOrGreater: 'Éclair' })).toEqual(
            all,
        );
        expect(await browse({ mediaTypes: ['movie'], nameLessThan: 'The Lantern' })).toEqual([
            eclair,
            hack,
        ]);
    });
});

describe('list caps', () => {
    it('ImageTypes names only unknown types: nothing matches', async () => {
        await item({ title: 'A', metadata: { backdrop_path: '/b.jpg' } });
        expect(await browse({ mediaTypes: ['movie'], imageTypes: ['Nonsense'] })).toEqual([]);
        expect(
            await browse({
                mediaTypes: ['movie'],
                imageTypes: ['Backdrop', 'backdrop', 'Nonsense'],
            }),
        ).toHaveLength(1);
    });

    it('a huge ExcludeItemIds / OfficialRatings list still answers', async () => {
        const a = await item({ title: 'A', metadata: { content_rating: 'PG' } });
        const ids = Array.from({ length: 5000 }, () => randomUUID());
        expect(await browse({ mediaTypes: ['movie'], excludeIds: ids })).toEqual([a]);
        const ratings = Array.from({ length: 5000 }, (_, i) => `R${i}`);
        expect(
            await browse({ mediaTypes: ['movie'], officialRatings: ['PG', ...ratings] }),
        ).toEqual([a]);
    });
});

describe('EnableTotalRecordCount=false', () => {
    it('issues no count query', async () => {
        await item({ title: 'A' });
        await item({ title: 'B' });
        const texts: string[] = [];
        const spy = new Proxy(sql, {
            apply(target, thisArg, args) {
                const strings = args[0] as readonly string[] | undefined;
                if (Array.isArray(strings)) texts.push(strings.join('?'));
                return Reflect.apply(target as never, thisArg, args);
            },
        }) as postgres.Sql;
        const base = {
            mediaTypes: ['movie'],
            parentId: null,
            searchTerm: null,
            genres: [],
            years: [],
            nameStartsWith: null,
            isFavoriteFilter: false,
            isPlayedFilter: false,
            isUnplayedFilter: false,
            enableUserData: false,
            userId,
            idList: [],
            sortBy: 'SortName',
            sortOrder: 'Ascending',
            limit: 1,
            access: unrestrictedAccess(),
        };
        const skipped = await browseMediaItems(spy, { ...base, startIndex: 0, skipCount: true });
        expect(skipped.rows).toHaveLength(1);
        expect(texts.join(' ')).not.toMatch(/COUNT\s*\(/i);
        // Past the end: still no fallback count.
        texts.length = 0;
        const past = await browseMediaItems(spy, { ...base, startIndex: 10, skipCount: true });
        expect(past.rows).toHaveLength(0);
        expect(texts.join(' ')).not.toMatch(/COUNT\s*\(/i);
        // Control: without the flag the count is issued.
        texts.length = 0;
        const counted = await browseMediaItems(spy, { ...base, startIndex: 0 });
        expect(counted.totalCount).toBe(2);
        expect(texts.join(' ')).toMatch(/COUNT\s*\(/i);
    });
});

describe('OfficialRatings and Tags', () => {
    it('match the certification and the keywords (case-insensitive)', async () => {
        const pg = await item({
            title: 'Rated PG',
            metadata: { content_rating: 'PG', keywords: ['Heist', 'friendship'] },
        });
        // A stored rating with stray whitespace still matches what Filters offers.
        const r = await item({
            title: 'Rated R',
            metadata: { content_rating: 'R ', keywords: [] },
        });
        expect(await browse({ mediaTypes: ['movie'], officialRatings: ['PG', 'TV-Y'] })).toEqual([
            pg,
        ]);
        expect(await browse({ mediaTypes: ['movie'], officialRatings: ['R'] })).toEqual([r]);
        expect(await browse({ mediaTypes: ['movie'], tags: ['heist'] })).toEqual([pg]);
        expect(await browse({ mediaTypes: ['movie'], tags: ['space'] })).toEqual([]);
    });
});

describe('Filters offer the tags /Items filters on', () => {
    it('lists the distinct keywords of the items in scope, hiding inaccessible ones', async () => {
        await item({ title: 'One', metadata: { keywords: ['heist', 'Paris'] } });
        await item({ title: 'Two', metadata: { keywords: ['heist', ' '] } });
        await item({ title: 'Adults', ageRating: 18, metadata: { keywords: ['secret'] } });
        const all = await getJellyfinFilterValues(sql, {
            parentId: null,
            mediaTypes: ['movie'],
            access: unrestrictedAccess(),
        });
        expect(all.tags).toEqual(['heist', 'Paris', 'secret']);
        const kid = await getJellyfinFilterValues(sql, {
            parentId: null,
            mediaTypes: ['movie'],
            access: restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: true }),
        });
        expect(kid.tags).toEqual(['heist', 'Paris']);
    });
});

describe('AudioLanguages / SubtitleLanguages', () => {
    it('match a movie by its streams and sidecars, `und` by streams without a language', async () => {
        const ger = await item({ title: 'German', audio: ['ger'], subtitles: ['eng'] });
        const eng = await item({ title: 'English', audio: ['eng'], sidecarSubtitles: ['ger'] });
        const none = await item({ title: 'Silent', audio: [null] });
        expect(
            await browse({ mediaTypes: ['movie'], audioLanguages: ['ger', 'deu', 'de'] }),
        ).toEqual([ger]);
        expect(await browse({ mediaTypes: ['movie'], subtitleLanguages: ['ger'] })).toEqual([eng]);
        expect(await browse({ mediaTypes: ['movie'], subtitleLanguages: ['eng'] })).toEqual([ger]);
        expect(await browse({ mediaTypes: ['movie'], audioLanguages: ['und'] })).toEqual([none]);
    });

    it('match a series through its episodes', async () => {
        const show = await item({ title: 'Show', type: 'tv' });
        const season = await item({ title: 'Season 1', type: 'season', parentId: show });
        await item({ title: 'Ep', type: 'episode', parentId: season, audio: ['jpn'] });
        const other = await item({ title: 'Other', type: 'tv' });
        const otherSeason = await item({ title: 'Season 1', type: 'season', parentId: other });
        await item({ title: 'Ep', type: 'episode', parentId: otherSeason, audio: ['eng'] });
        expect(await browse({ mediaTypes: ['tv'], audioLanguages: ['jpn'] })).toEqual([show]);
        // No type filter and not a recursive scan: series are candidates too.
        expect(await browse({ audioLanguages: ['jpn'] })).toContain(show);
    });

    it('only look at children when the request can return a series, season or album', async () => {
        const show = await item({ title: 'Show', type: 'tv' });
        const season = await item({ title: 'Season 1', type: 'season', parentId: show });
        const ep = await item({ title: 'Ep', type: 'episode', parentId: season, audio: ['jpn'] });
        // Episodes match on themselves; the series is not looked at.
        expect(await browse({ mediaTypes: ['episode'], audioLanguages: ['jpn'] })).toEqual([ep]);
        // A recursive scan without types is movies / episodes / tracks.
        expect(await browse({ recursive: true, audioLanguages: ['jpn'] })).toEqual([ep]);
        expect(await browse({ mediaTypes: ['season'], audioLanguages: ['jpn'] })).toEqual([season]);
    });
});

describe('ImageTypes', () => {
    it('keeps items with an image of one of the types', async () => {
        const withBackdrop = await item({
            title: 'Backdrop',
            metadata: { backdrop_path: '/b.jpg' },
        });
        const withLogo = await item({ title: 'Logo' });
        await sql`UPDATE media_items SET custom_logo_url = 'https://example.test/logo.png' WHERE id = ${withLogo}::uuid`;
        const bare = await item({ title: 'Bare' });
        await sql`INSERT INTO media_artwork (media_item_id, artwork_type, file_path)
                  VALUES (${bare}::uuid, 'thumb', '/art/thumb.jpg')`;
        expect(await browse({ mediaTypes: ['movie'], imageTypes: ['Backdrop'] })).toEqual([
            withBackdrop,
        ]);
        expect(await browse({ mediaTypes: ['movie'], imageTypes: ['Logo', 'Thumb'] })).toEqual([
            bare,
            withLogo,
        ]);
        expect(await browse({ mediaTypes: ['movie'], imageTypes: ['Banner'] })).toEqual([]);
        await sql`UPDATE image_candidates SET suppressed=true,selected=false WHERE media_item_id=${bare}`;
        expect(await browse({ mediaTypes: ['movie'], imageTypes: ['Thumb'] })).toEqual([]);
    });
});

describe('AlbumIds / AlbumArtistIds', () => {
    it('select tracks of an album, and albums and tracks of an artist', async () => {
        const artist = await item({ title: 'Artist', type: 'artist' });
        const album = await item({ title: 'Album', type: 'album', parentId: artist });
        const track = await item({ title: 'Track', type: 'track', parentId: album });
        const otherAlbum = await item({ title: 'Other album', type: 'album' });
        await item({ title: 'Other track', type: 'track', parentId: otherAlbum });
        expect(await browse({ mediaTypes: ['track'], albumIds: [album] })).toEqual([track]);
        expect(await browse({ mediaTypes: ['album', 'track'], albumArtistIds: [artist] })).toEqual([
            album,
            track,
        ]);
    });
});

describe('HasParentalRating / MaxOfficialRating', () => {
    it('unrated only; max rating lets unrated through and judges episodes by their series', async () => {
        const unrated = await item({ title: 'A unrated' });
        const kids = await item({ title: 'B kids', ageRating: 6 });
        await item({ title: 'C adults', ageRating: 18 });
        expect(await browse({ mediaTypes: ['movie'], unratedOnly: true })).toEqual([unrated]);
        expect(await browse({ mediaTypes: ['movie'], maxAge: 12 })).toEqual([unrated, kids]);

        const show = await item({ title: 'Adult show', type: 'tv', ageRating: 18 });
        const season = await item({ title: 'Season 1', type: 'season', parentId: show });
        const ep = await item({ title: 'Ep', type: 'episode', parentId: season });
        expect(await browse({ mediaTypes: ['episode'], maxAge: 12 })).toEqual([]);
        expect(await browse({ mediaTypes: ['episode'], maxAge: 18 })).toEqual([ep]);
    });
});

describe('access boundary', () => {
    it('a filter never reaches an item the boundary hides', async () => {
        await item({ title: 'Adults', ageRating: 18, metadata: { keywords: ['heist'] } });
        expect(
            await browse({
                mediaTypes: ['movie'],
                tags: ['heist'],
                access: restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: true,
                }),
            }),
        ).toEqual([]);
    });
});
