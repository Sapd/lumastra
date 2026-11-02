// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration tests for the per-track artist projection on the queue path.
 *
 * Covers the two defects that made a multi-artist track render as one link to
 * the wrong artist:
 *
 *   1. `resolved_artist_id` came from the album→artist hierarchy, which on a
 *      compilation is the "Various Artists" marker — so the line displayed the
 *      track's own tag ("DJ Fenwick, Milo Sebastian") but linked to VA.
 *   2. The queue queries never emitted `track_artists`, so the structured
 *      artist list the projection and Zod schema already support arrived
 *      undefined and no per-artist link was possible.
 *
 * Both are fixed by SQL fragments (`trackArtistsSql`, `nonVariousArtistIdSql`),
 * so these tests assert against the real query output rather than the fragment
 * in isolation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { toUserId } from '$lib/shared/user-id';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
    musicFixtureEmbeddingLiteral,
    derivedUsername,
} from '../../../../../tests/integration/fixtures/index.js';
import { getAlbumWithTracks, getSmartQueueCandidates, getTrackDetail } from './music.queries.js';
import { toMusicTrack } from '$lib/server/services/music/track-projection.js';
import { replaceArtistIdInTracks } from './artist-merge.queries.js';
import { musicImagesFixture } from '$lib/server/services/music/__tests__/image-fixtures.js';

/**
 * Insert a music embedding so the track can surface as a candidate.
 *
 * Deliberately NOT an all-zero vector: `<=>` against zero is NaN, and the
 * partial HNSW index on `source = 'music'` returns none of these rows once the
 * planner prefers it — see musicFixtureEmbeddingLiteral for the measurement.
 * Every row still shares one vector, so all candidates remain exactly tied.
 */
async function insertMusicEmbedding(sql: postgres.Sql, mediaId: string): Promise<void> {
    const vectorString = musicFixtureEmbeddingLiteral();
    await sql`
        INSERT INTO media_embeddings (media_id, source, embedding)
        VALUES (${mediaId}::uuid, 'music', ${vectorString}::vector)
    `;
}

describe('queue path — per-track artists', () => {
    let sql: postgres.Sql;
    const USER = toUserId(randomUUID());

    // Various Artists compilation
    let vaArtistId: string;
    let djAmadeusId: string;
    let marioSebastianId: string;
    let compilationTrackId: string;

    // Normal single-artist album
    let soloArtistId: string;
    let soloTrackId: string;

    // The track the queue is seeded from
    let seedTrackId: string;

    beforeAll(async () => {
        sql = getTestDb();

        // Shared fixture for the whole file — truncate once here rather than
        // per-test. media_items carries a unique index on the normalized artist
        // title (uq_music_artist_norm_title), so leftovers from a previous run
        // would collide on re-insert.
        await sql.unsafe(
            'TRUNCATE TABLE media_embeddings, media_file_items, media_files, watch_history, media_items CASCADE',
        );

        await sql`
            INSERT INTO users (id, username)
            VALUES (${USER}::uuid, ${derivedUsername(USER)})
            ON CONFLICT (id) DO NOTHING
        `;

        // ── Various Artists compilation ──────────────────────────────────
        // Mirrors the reported prod row: the album's parent artist is the VA
        // marker, while the track's own tag names two real performers whose
        // ids the scanner wrote to additional_artist_ids.
        const vaArtist = createTestArtist({ title: 'Various Artists' });
        await insertTestArtist(sql, vaArtist);
        vaArtistId = vaArtist.id;
        await sql`
            UPDATE media_items SET is_various_artists = true WHERE id = ${vaArtistId}::uuid
        `;

        const djAmadeus = createTestArtist({ title: 'DJ Fenwick' });
        await insertTestArtist(sql, djAmadeus);
        djAmadeusId = djAmadeus.id;

        const marioSebastian = createTestArtist({ title: 'Milo Sebastian' });
        await insertTestArtist(sql, marioSebastian);
        marioSebastianId = marioSebastian.id;

        const compilationAlbum = createTestAlbum(vaArtistId, {
            title: 'Hands Up Essentials, Vol. 2',
        });
        await insertTestAlbum(sql, compilationAlbum);

        const compilationTrack = createTestTrack(compilationAlbum.id, 1, {
            title: 'Berlin (feat. Milo Sebastian) (Marina Radio Edit)',
            custom_metadata: {
                artist: 'DJ Fenwick, Milo Sebastian',
                additional_artist_ids: [djAmadeusId, marioSebastianId],
            },
        });
        await insertTestTrack(sql, compilationTrack);
        compilationTrackId = compilationTrack.id;

        // ── Normal single-artist album ───────────────────────────────────
        const soloArtist = createTestArtist({ title: 'Solo Performer' });
        await insertTestArtist(sql, soloArtist);
        soloArtistId = soloArtist.id;

        const soloAlbum = createTestAlbum(soloArtistId, { title: 'Solo Album' });
        await insertTestAlbum(sql, soloAlbum);

        const soloTrack = createTestTrack(soloAlbum.id, 2, {
            title: 'Solo Track',
            custom_metadata: { artist: 'Solo Performer' },
        });
        await insertTestTrack(sql, soloTrack);
        soloTrackId = soloTrack.id;

        // ── Seed track the queue starts from ─────────────────────────────
        const seedArtist = createTestArtist({ title: 'Seed Artist' });
        await insertTestArtist(sql, seedArtist);
        const seedAlbum = createTestAlbum(seedArtist.id, { title: 'Seed Album' });
        await insertTestAlbum(sql, seedAlbum);
        const seedTrack = createTestTrack(seedAlbum.id, 3, { title: 'Seed Track' });
        await insertTestTrack(sql, seedTrack);
        seedTrackId = seedTrack.id;

        for (const id of [seedTrackId, compilationTrackId, soloTrackId]) {
            await insertMusicEmbedding(sql, id);
        }
    });

    afterAll(async () => {
        await closeTestDb();
    });

    async function fetchCandidate(trackId: string) {
        const results = await getSmartQueueCandidates(sql, seedTrackId, [], 50, {
            userId: USER,
        });
        return results.find((row) => row.id === trackId);
    }

    it('returns both tagged artists in tag order for a compilation track', async () => {
        const row = await fetchCandidate(compilationTrackId);

        expect(row).toBeDefined();
        expect(row?.track_artists).toEqual([
            { id: djAmadeusId, title: 'DJ Fenwick' },
            { id: marioSebastianId, title: 'Milo Sebastian' },
        ]);
    });

    it('never hands out the Various Artists id as a link target', async () => {
        const row = await fetchCandidate(compilationTrackId);

        expect(row?.resolved_artist_id).toBeNull();
        expect(row?.resolved_artist_id).not.toBe(vaArtistId);
    });

    it('displays the track tag as-cased on a compilation', async () => {
        const row = await fetchCandidate(compilationTrackId);

        // resolved_artist is a DISPLAY value (toMusicTrack reads it as the
        // artist name). It used to be LOWER()ed to serve the per-artist
        // PARTITION BY, which leaked lowercase names into Up Next / autoplay.
        // The case-folding now lives in the partitions instead.
        expect(row?.resolved_artist).toBe('DJ Fenwick, Milo Sebastian');
    });

    it('leaves track_artists null for a track whose artist is the album artist', async () => {
        const row = await fetchCandidate(soloTrackId);

        expect(row).toBeDefined();
        expect(row?.track_artists ?? null).toBeNull();
    });

    it('keeps the hierarchy artist id for a normal, non-compilation album', async () => {
        const row = await fetchCandidate(soloTrackId);

        expect(row?.resolved_artist_id).toBe(soloArtistId);
    });

    it('survives a malformed additional_artist_ids entry without killing the query', async () => {
        // The ::uuid cast sits in a scalar subquery on the candidates CTE, so an
        // "invalid input syntax for type uuid" would abort the WHOLE statement —
        // one corrupted track would take autoplay down for every user whose
        // candidate pool touched it. The bad entry must be skipped, the good one
        // kept, and every other candidate must still come back.
        const goodArtist = createTestArtist({ title: 'Legit Artist' });
        await insertTestArtist(sql, goodArtist);

        const junkAlbum = createTestAlbum(goodArtist.id, { title: 'Junk Album' });
        await insertTestAlbum(sql, junkAlbum);

        const junkTrack = createTestTrack(junkAlbum.id, 6, {
            title: 'Junk Ids Track',
            custom_metadata: {
                artist: 'Legit Artist, Not An Id',
                additional_artist_ids: [
                    goodArtist.id,
                    'not-a-uuid',
                    '',
                    '12345',
                    'ffffffff-ffff-ffff-ffff-ffffffffffff',
                ],
            },
        });
        await insertTestTrack(sql, junkTrack);
        await insertMusicEmbedding(sql, junkTrack.id);

        const results = await getSmartQueueCandidates(sql, seedTrackId, [], 50, {
            userId: USER,
        });

        // The query itself must not have thrown, and unrelated rows survive.
        expect(results.length).toBeGreaterThan(1);

        const row = results.find((r) => r.id === junkTrack.id);
        expect(row?.track_artists).toEqual([{ id: goodArtist.id, title: 'Legit Artist' }]);
    });

    it('still collapses case-variant artists when deduping titles', async () => {
        // Guards the LOWER() move: case-folding left the projection (so names
        // display as tagged) and moved into the PARTITION BYs. Two spellings of
        // the same artist with the same track title must still dedup to one.
        const caseArtist = createTestArtist({ title: 'Case Artist' });
        await insertTestArtist(sql, caseArtist);
        const caseAlbum = createTestAlbum(caseArtist.id, { title: 'Case Album' });
        await insertTestAlbum(sql, caseAlbum);

        const upper = createTestTrack(caseAlbum.id, 4, {
            title: 'Same Song',
            custom_metadata: { artist: 'Foo Bar' },
        });
        await insertTestTrack(sql, upper);
        await insertMusicEmbedding(sql, upper.id);

        const lower = createTestTrack(caseAlbum.id, 5, {
            title: 'Same Song',
            custom_metadata: { artist: 'foo bar' },
        });
        await insertTestTrack(sql, lower);
        await insertMusicEmbedding(sql, lower.id);

        const results = await getSmartQueueCandidates(sql, seedTrackId, [], 50, {
            userId: USER,
        });
        const sameSong = results.filter((row) => row.title === 'Same Song');

        expect(sameSong).toHaveLength(1);
    });
});

describe('album and detail paths — paired primary and additional credits', () => {
    let sql: postgres.Sql;
    let albumId: string;
    let primaryId: string;
    let additionalId: string;
    let thirdId: string;
    const trackIds = new Map<string, string>();

    beforeAll(async () => {
        sql = getTestDb();
        const primary = createTestArtist({ title: 'DJ Northwind' });
        const additional = createTestArtist({ title: 'Silver Meadow' });
        const third = createTestArtist({ title: 'Amber Harbor' });
        for (const artist of [primary, additional, third]) {
            await insertTestArtist(sql, artist);
        }
        primaryId = primary.id;
        additionalId = additional.id;
        thirdId = third.id;

        const album = createTestAlbum(primaryId, { title: 'Northern Remix Collection' });
        await insertTestAlbum(sql, album);
        albumId = album.id;

        // Mirrors the incident without requiring meta.artists: the singular
        // artist and album owner are primary, while the other credit is stored
        // only in additional_artist_ids.
        const cases = [
            { key: 'remix', artist: primary.title, ids: [additionalId] },
            {
                key: 'duplicates',
                artist: primary.title,
                ids: [additionalId, primaryId, thirdId, additionalId],
            },
            {
                key: 'additional-only',
                artist: 'Silver Meadow & Amber Harbor',
                ids: [additionalId, thirdId],
            },
            { key: 'solo', artist: primary.title, ids: [] },
            { key: 'raw', artist: 'Unresolved Night Chorus', ids: [] },
        ];
        for (const [index, fixture] of cases.entries()) {
            const track = createTestTrack(albumId, index + 1, {
                title: `Credit Regression ${fixture.key}`,
                custom_metadata: {
                    artist: fixture.artist,
                    album_artist: primary.title,
                    additional_artist_ids: fixture.ids,
                },
            });
            await insertTestTrack(sql, track);
            trackIds.set(fixture.key, track.id);
        }
    });

    afterAll(async () => {
        await closeTestDb();
    });

    it.each(['remix', 'duplicates', 'additional-only', 'solo', 'raw'])(
        'preserves ordered paired credits and album identity for %s before and after hydration',
        async (key) => {
            const trackId = trackIds.get(key)!;
            const albumResult = await getAlbumWithTracks(sql, albumId);
            const albumTrack = albumResult?.tracks.find((track) => track.id === trackId);
            const detail = await getTrackDetail(sql, trackId);
            const primary = { id: primaryId, title: 'DJ Northwind' };
            const additional = { id: additionalId, title: 'Silver Meadow' };
            const expected =
                key === 'remix'
                    ? [primary, additional]
                    : key === 'duplicates'
                      ? [primary, additional, { id: thirdId, title: 'Amber Harbor' }]
                      : key === 'additional-only'
                        ? [additional, { id: thirdId, title: 'Amber Harbor' }]
                        : key === 'solo'
                          ? [primary]
                          : [{ id: null, title: 'Unresolved Night Chorus' }];

            expect(albumResult?.album.artist_id).toBe(primaryId);
            expect(albumTrack).toBeDefined();
            expect(detail).not.toBeNull();
            expect(albumTrack?.track_artists).toEqual(expected);
            expect(detail?.track_artists).toEqual(expected);

            if (!albumTrack || !detail) throw new Error('Expected both real query results');
            const images = musicImagesFixture(trackId, 'internal');
            const beforeHydration = toMusicTrack(albumTrack, images);
            const afterHydration = toMusicTrack(detail, images);
            expect(beforeHydration.artists).toEqual(expected);
            expect(afterHydration.artists).toEqual(expected);
            expect(beforeHydration.album?.id).toBe(albumId);
            expect(afterHydration.album?.id).toBe(albumId);
        },
    );
});

describe('canonical performer credits', () => {
    let sql: postgres.Sql;
    let albumId: string;
    let trackId: string;
    let performerId: string;
    let remixerId: string;
    let replacementId: string;

    beforeAll(async () => {
        sql = getTestDb();
        const owner = createTestArtist({ title: 'Canonical Album Owner' });
        const performer = createTestArtist({ title: 'Canonical Silver Singer' });
        const remixer = createTestArtist({ title: 'Canonical Night Mixer' });
        const replacement = createTestArtist({ title: 'Canonical Replacement Singer' });
        for (const artist of [owner, performer, remixer, replacement])
            await insertTestArtist(sql, artist);
        performerId = performer.id;
        remixerId = remixer.id;
        replacementId = replacement.id;
        const album = createTestAlbum(owner.id, { title: 'Canonical Projection Collection' });
        await insertTestAlbum(sql, album);
        albumId = album.id;
        const track = createTestTrack(albumId, 1, {
            title: 'Canonical Song (Canonical Night Mixer remix)',
            custom_metadata: {
                artist: 'canonical silver singer',
                album_artist: owner.title,
                raw_artist_tags: { source: 'file', artist: 'canonical silver singer' },
                track_artist_credits: [
                    { id: performerId, credited_name: 'canonical silver singer' },
                    { id: 'not-a-uuid', credited_name: 'Unresolved Guest' },
                ],
                additional_artist_ids: [performerId, remixerId, owner.id],
                file_artist_ids: [performerId],
                album_artist_ids: [owner.id],
                remixer_artist_ids: [remixerId],
            },
        });
        await insertTestTrack(sql, track);
        trackId = track.id;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    it('pairs canonical performer names with identities and keeps remixers separate from album ownership', async () => {
        const detail = await getTrackDetail(sql, trackId);
        const album = await getAlbumWithTracks(sql, albumId);
        const expected = [
            { id: performerId, title: 'Canonical Silver Singer' },
            { id: null, title: 'Unresolved Guest' },
        ];
        expect(detail?.track_artists).toEqual(expected);
        expect(album?.tracks.find((row) => row.id === trackId)?.track_artists).toEqual(expected);
        expect(detail?.track_artist_id).toBe(performerId);
        expect(detail?.remixer_artists).toEqual([
            { id: remixerId, title: 'Canonical Night Mixer' },
        ]);
        expect(detail?.custom_metadata.raw_artist_tags).toEqual({
            source: 'file',
            artist: 'canonical silver singer',
        });
        if (!detail) throw new Error('Expected a track');
        const projected = toMusicTrack(detail, musicImagesFixture(trackId, 'internal'));
        expect(projected.artists).toEqual(expected);
        expect(projected.remixerArtists).toEqual(detail.remixer_artists);
    });

    it('uses live canonical spelling after a rename without rewriting source evidence', async () => {
        await sql`UPDATE media_items SET title = 'Renamed Canonical Singer' WHERE id = ${performerId}::uuid`;
        const detail = await getTrackDetail(sql, trackId);
        expect(detail?.track_artists?.[0]).toEqual({
            id: performerId,
            title: 'Renamed Canonical Singer',
        });
        expect(detail?.custom_metadata.artist).toBe('canonical silver singer');
    });

    it('ignores malformed canonical elements and treats an empty list as absent', async () => {
        const malformedTrack = createTestTrack(albumId, 20, {
            title: 'Malformed Canonical Credits',
            custom_metadata: {
                artist: 'Old Performer',
                artists: ['Old Performer'],
                track_artist_credits: [
                    null,
                    'text',
                    7,
                    [],
                    { credited_name: {} },
                    { id: 'not-a-uuid', credited_name: 'Unresolved Night Guest' },
                ],
            },
        });
        await insertTestTrack(sql, malformedTrack);
        const malformed = await getTrackDetail(sql, malformedTrack.id);
        expect(malformed?.track_artists).toEqual([{ id: null, title: 'Unresolved Night Guest' }]);
        await sql`UPDATE media_items SET custom_metadata = custom_metadata || '{"track_artist_credits":[]}'::jsonb
            WHERE id = ${malformedTrack.id}::uuid`;
        const empty = await getTrackDetail(sql, malformedTrack.id);
        // An empty list is "no canonical credits": legacy resolution applies.
        expect(empty?.track_artists).toEqual([{ id: null, title: 'Old Performer' }]);
        expect(empty?.artist_title).toBe('Old Performer');
        expect(empty?.track_artist_title).toBe('Old Performer');
        const album = await getAlbumWithTracks(sql, albumId);
        expect(
            album?.tracks.find((track) => track.id === malformedTrack.id)?.track_artist_title,
        ).toBe('Old Performer');
    });

    it('remaps and deduplicates every owned credit before artist deletion', async () => {
        await sql`UPDATE media_items SET custom_metadata = custom_metadata || ${sql.json({
            track_artist_credits: [
                { id: performerId, credited_name: 'original source name' },
                { id: replacementId, credited_name: 'replacement source name' },
                { id: null, credited_name: 'Unresolved Merge Guest' },
            ],
            additional_artist_ids: [performerId, replacementId, remixerId],
            file_artist_ids: [performerId, replacementId],
            album_artist_ids: [performerId, replacementId],
            remixer_artist_ids: [performerId, replacementId, remixerId],
            title_remixer_artist_ids: [performerId, replacementId, remixerId],
            independent_remixer_artist_ids: [performerId, replacementId, remixerId],
        })} WHERE id = ${trackId}::uuid`;
        await replaceArtistIdInTracks(sql, performerId, replacementId);
        const [stored] =
            await sql`SELECT custom_metadata FROM media_items WHERE id = ${trackId}::uuid`;
        expect(stored.custom_metadata.track_artist_credits).toEqual([
            { id: replacementId, credited_name: 'original source name' },
            { id: null, credited_name: 'Unresolved Merge Guest' },
        ]);
        expect(stored.custom_metadata.file_artist_ids).toEqual([replacementId]);
        expect(stored.custom_metadata.album_artist_ids).toEqual([replacementId]);
        expect(stored.custom_metadata.remixer_artist_ids).toEqual([replacementId, remixerId]);
        expect(stored.custom_metadata.title_remixer_artist_ids).toEqual([replacementId, remixerId]);
        expect(stored.custom_metadata.independent_remixer_artist_ids).toEqual([
            replacementId,
            remixerId,
        ]);
        expect(stored.custom_metadata.additional_artist_ids).toEqual([replacementId, remixerId]);
        const detail = await getTrackDetail(sql, trackId);
        expect(detail?.track_artists).toEqual([
            { id: replacementId, title: 'Canonical Replacement Singer' },
            { id: null, title: 'Unresolved Merge Guest' },
        ]);
    });
});
