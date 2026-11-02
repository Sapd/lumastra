// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Music Recommendations Query Module
 *
 * Tests Because You Listened, Smart Mixes, and Mood Recommendations.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMusicHierarchy,
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getMusicBecauseYouListened,
    getMusicSmartMixes,
    getMusicMoodRecommendations,
    getMoodShelfTracks,
    getNewForYouTracks,
} from './music-recommendations.queries.js';
import {
    unrestrictedAccess,
    restrictedAccess,
    denyAllAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';

/** Create a library group and return its id. */
async function createLibraryGroup(sql: postgres.Sql, name: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO library_groups (id, name) VALUES (${id}::uuid, ${name})`;
    return id;
}

/** Point a track's fixture-created media_files row at a library group. */
async function moveTrackFileToGroup(
    sql: postgres.Sql,
    trackId: string,
    libraryGroupId: string,
): Promise<void> {
    await sql`
        UPDATE media_files mf
        SET library_group_id = ${libraryGroupId}::uuid
        FROM media_file_items mfi
        WHERE mfi.file_id = mf.id
          AND mfi.media_item_id = ${trackId}::uuid
    `;
}

/** Boundary denying exactly the given library groups; age unrestricted. */
function denyGroups(...ids: string[]): MediaAccessBoundary {
    return restrictedAccess({ deniedGroupIds: ids, maxAgeRating: null, allowUnrated: true });
}

// Titles that all normalize (post-dedup) to the same "song one" partition key
// — one untagged original plus two bracketed variants. Regression fixture
// for d1fe342e2: the dedup regex was inlined into a sql`` template and got
// cooked by postgres.js before reaching Postgres, so none of these variants
// ever collapsed onto the original.
const VARIANT_TITLES = ['Song One', 'Song One (Radio Edit)', 'Song One (Club Remix)'];

/**
 * Seed one artist/album with the three VARIANT_TITLES tracks against a
 * freshly-inserted MSCLAP mood vector — plus one unrelated artist/track so
 * the shelf has other material to draw from besides the variant group.
 *
 * The untagged original ("Song One", index 0) gets the exact mood vector
 * (zero distance); the two variants get a copy nudged by a tiny epsilon in
 * one dimension (near-zero but strictly non-zero distance). All three still
 * collapse onto the same title/artist_rank partition, but the untagged
 * original is now also the unambiguous nearest match — without this, three
 * exactly-tied (zero-distance) candidates broken only by random UUID
 * ordering could put the preferred title outside the artist_rank cutoff on
 * an unlucky draw, flaking the assertion below.
 */
async function seedVariantTitleMoodFixture(sql: postgres.Sql, moodKey: string): Promise<void> {
    // DETERMINISTIC vectors (not Math.random). The mood vector, the original's
    // embedding, and the epsilon-nudged variant embedding are fixed, so the
    // variant group sits at distance ~0 while any unrelated random-embedding
    // track lands far away — every run, not on a lucky draw. Combined with the
    // deterministic ordered track ids below (original < variants), the
    // distance-then-id tiebreak in getMoodShelfTracks/getMusicMoodRecommendations
    // resolves the same way every time, removing the historical flake this
    // fixture kept hitting under a shifting global RNG stream.
    const sharedVector = Array.from({ length: 1024 }, (_, i) => 0.25 + (i % 7) * 0.01);
    const sharedVectorString = `[${sharedVector.join(',')}]`;
    const nudgedVector = [...sharedVector];
    nudgedVector[0] += 0.0005;
    const nudgedVectorString = `[${nudgedVector.join(',')}]`;

    await sql`
        INSERT INTO mood_vectors (mood_key, display_name, vector, model_id)
        VALUES (${moodKey}, 'Test Mood', ${sharedVectorString}::vector, ${MSCLAP_MODEL_ID})
    `;

    const artist = createTestArtist({ title: `Variant Artist ${randomUUID().slice(0, 8)}` });
    const album = createTestAlbum(artist.id);
    await insertTestArtist(sql, artist);
    await insertTestAlbum(sql, album);

    for (const [index, title] of VARIANT_TITLES.entries()) {
        const track = createTestTrack(album.id, index + 1, {
            // Ordered ids: the untagged original (index 0) is the smallest, so
            // it deterministically wins the `... , id ASC` tiebreak and is the
            // row kept by the title_rank<=1 collapse.
            id: `00000000-0000-4000-8000-00000000000${index}`,
            title,
            custom_metadata: { artist: artist.title, album: album.title },
        });
        await insertTestTrack(sql, track);
        // index 0 ("Song One", the untagged original) is the exact mood
        // vector; the two variants get the epsilon-nudged copy.
        const embeddingVectorString = index === 0 ? sharedVectorString : nudgedVectorString;
        await sql`
            INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
            VALUES (${track.id}::uuid, ${MSCLAP_MODEL_ID}, ${embeddingVectorString}::vector)
        `;
    }

    // Unrelated artist/track so the shelf has other material besides the
    // variant group.
    await createAndInsertTestMusicHierarchy(sql, { trackCount: 1, withEmbeddings: true });
}

describe('Music Recommendations Queries', () => {
    let sql: postgres.Sql;
    const userId: UserId = toUserId(randomUUID());

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'watch_history',
            'mood_vectors',
            ...TEST_TABLES.userData,
            ...TEST_TABLES.mediaFiles,
            ...TEST_TABLES.media,
        ]);
        await ensureTestUser(sql, userId);
    });

    // ========================================================================
    // getMusicBecauseYouListened
    // ========================================================================

    describe('getMusicBecauseYouListened', () => {
        it('returns similar tracks based on embedding', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 3,
                withEmbeddings: true,
            });

            const results = await getMusicBecauseYouListened(
                sql,
                trackIds[0],
                ['00000000-0000-0000-0000-000000000000'],
                2,
                {
                    deniedGroupIds: null,
                    ageRating: null,
                },
            );

            expect(results.length).toBeGreaterThan(0);
            expect(results.every((r) => r.id !== trackIds[0])).toBe(true);
            expect(results[0].similarity).toBeDefined();
        });

        it('excludes caller-supplied ids', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
                withEmbeddings: true,
            });

            const results = await getMusicBecauseYouListened(sql, trackIds[0], [trackIds[1]], 2, {
                deniedGroupIds: null,
                ageRating: null,
            });

            expect(results.some((r) => r.id === trackIds[1])).toBe(false);
        });

        it('returns empty array when no embeddings exist', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });

            // Pass a dummy valid UUID to work around source query bug with empty excludeIds
            const results = await getMusicBecauseYouListened(
                sql,
                trackIds[0],
                ['00000000-0000-0000-0000-000000000000'],
                2,
                {
                    deniedGroupIds: null,
                    ageRating: null,
                },
            );

            expect(results).toEqual([]);
        });

        it('exempts a flagged VA artist from the per-artist cap (flag-driven, not name-driven)', async () => {
            // MAX_TRACKS_PER_ARTIST is 2 inside getMusicBecauseYouListened. Three
            // VA tracks in three distinct albums (so the per-album cap can't
            // also explain the result) must all survive, proving the cap
            // exemption is driven by is_various_artists rather than a
            // LOWER(artist_title) = 'various artists' name compare.
            const { trackIds: seedTrackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
                withEmbeddings: true,
            });
            const seedTrackId = seedTrackIds[0];

            const vaArtist = createTestArtist({ title: 'Countstep VA BYL Bucket' });
            await insertTestArtist(sql, vaArtist);
            await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${vaArtist.id}::uuid`;

            const vaTrackIds: string[] = [];
            for (let index = 0; index < 3; index++) {
                const vaAlbum = createTestAlbum(vaArtist.id);
                await insertTestAlbum(sql, vaAlbum);
                const track = createTestTrack(vaAlbum.id, 1, {
                    custom_metadata: { artist: '', album: vaAlbum.title },
                });
                await insertTestTrack(sql, track);
                vaTrackIds.push(track.id);
                const embeddingVector = Array.from({ length: 1024 }, () => Math.random());
                const embeddingVectorString = `[${embeddingVector.join(',')}]`;
                await sql`
                    INSERT INTO media_embeddings (media_id, embedding, source)
                    VALUES (${track.id}::uuid, ${embeddingVectorString}::vector, 'music')
                `;
            }

            const results = await getMusicBecauseYouListened(
                sql,
                seedTrackId,
                ['00000000-0000-0000-0000-000000000000'],
                10,
                { deniedGroupIds: null, ageRating: null },
            );

            const vaResults = results.filter((r) => vaTrackIds.includes(r.id));
            expect(vaResults).toHaveLength(3);
        });
    });

    // ========================================================================
    // getMusicSmartMixes
    // ========================================================================

    describe('getMusicSmartMixes', () => {
        it('returns genre-clustered mixes from listening history', async () => {
            const {
                artistId: _artistId,
                albumId,
                trackIds,
            } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
                withEmbeddings: true,
                genre: 'Electronic',
            });

            const albumPoster = '/test/smart-mix-album-cover.jpg';
            await sql`UPDATE media_items SET custom_poster_url = ${albumPoster} WHERE id = ${albumId}::uuid`;
            await sql`UPDATE media_items SET custom_poster_url = NULL WHERE id = ANY(${trackIds}::uuid[])`;

            // Seed user_music_state, NOT watch_history. Smart Mixes used to
            // read watch_history — the VIDEO playback path — which on the
            // production database holds 10,018 rows of which exactly 4 are
            // music tracks, so the feature returned an empty section list for
            // every user while still answering 200. This fixture previously
            // seeded watch_history and therefore passed against the broken
            // source; seeding where music playback is actually recorded is
            // what makes it load-bearing.
            for (const trackId of trackIds) {
                await sql`
                    INSERT INTO user_music_state (user_id, track_id, play_count, complete_count)
                    VALUES (${userId}::uuid, ${trackId}::uuid, 3, 2)
                    ON CONFLICT (user_id, track_id) DO UPDATE SET play_count = EXCLUDED.play_count
                `;
            }

            const mixes = await getMusicSmartMixes(sql, userId, 5, {
                deniedGroupIds: null,
                ageRating: null,
            });

            expect(mixes.length).toBeGreaterThan(0);
            const mix = mixes.find((m) => m.genre === 'electronic');
            expect(mix).toBeDefined();
            expect(mix!.tracks.length).toBeGreaterThan(0);
            for (const track of mix!.tracks) {
                expect(track.album_id).toBe(albumId);
                expect(track.custom_poster_url).toBe(albumPoster);
            }
        });

        it('builds a full selection beyond four tracks without repeating artists or disliked tracks', async () => {
            const candidates: string[] = [];
            for (let artist = 0; artist < 14; artist++) {
                const hierarchy = await createAndInsertTestMusicHierarchy(sql, {
                    trackCount: 3,
                    withEmbeddings: true,
                    genre: 'Electronic',
                });
                candidates.push(...hierarchy.trackIds);
            }
            await sql`
                INSERT INTO user_music_state (user_id, track_id, play_count, complete_count)
                VALUES (${userId}::uuid, ${candidates[0]}::uuid, 3, 2)
            `;
            const mixes = await getMusicSmartMixes(
                sql,
                userId,
                5,
                {
                    deniedGroupIds: null,
                    ageRating: null,
                },
                [candidates[0]],
            );
            const tracks = mixes.find((mix) => mix.genre === 'electronic')!.tracks;
            expect(tracks).toHaveLength(24);
            expect(new Set(tracks.map((track) => track.id)).size).toBe(24);
            expect(tracks.map((track) => track.id)).not.toContain(candidates[0]);
            const artists = new Map<string | null, number>();
            for (const track of tracks)
                artists.set(track.artist_id, (artists.get(track.artist_id) ?? 0) + 1);
            expect(Math.max(...artists.values())).toBeLessThanOrEqual(2);
        });

        it('normalizes scalar and array genres without adding empty genres', async () => {
            const genres: unknown[] = ['  Lunar Jazz ', ['LUNAR JAZZ', ''], null, '', []];
            const ids: string[] = [];
            for (const genre of genres) {
                const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                    trackCount: 1,
                    withEmbeddings: true,
                });
                ids.push(trackIds[0]);
                await sql`UPDATE media_items SET custom_metadata = jsonb_build_object('genre', ${sql.json(genre as postgres.JSONValue)}) WHERE id = ${trackIds[0]}::uuid`;
                await sql`INSERT INTO user_music_state (user_id, track_id, play_count) VALUES (${userId}::uuid, ${trackIds[0]}::uuid, 3)`;
            }
            const mixes = await getMusicSmartMixes(sql, userId, 5, {
                deniedGroupIds: null,
                ageRating: null,
            });
            expect(mixes.map((mix) => mix.genre)).toEqual(['lunar jazz']);
            expect(mixes[0].tracks.map((track) => track.id).sort()).toEqual(ids.slice(0, 2).sort());
        });

        it('applies library and age gates to history, centroid input and candidates', async () => {
            const deniedGroup = await createLibraryGroup(sql, 'Hidden music collection');
            const allowedIds: string[] = [];
            for (const [genre, hidden] of [
                ['Lunar Jazz', false],
                ['Lunar Jazz', true],
                ['Hidden Waves', true],
                ['Hidden Waves', false],
            ] as const) {
                const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                    trackCount: 1,
                    withEmbeddings: true,
                    genre,
                });
                const id = trackIds[0];
                await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${id}::uuid`;
                if (hidden) await moveTrackFileToGroup(sql, id, deniedGroup);
                else if (genre === 'Lunar Jazz') allowedIds.push(id);
                if (hidden || genre === 'Lunar Jazz')
                    await sql`INSERT INTO user_music_state (user_id, track_id, play_count) VALUES (${userId}::uuid, ${id}::uuid, 3)`;
            }
            for (const genre of ['Lunar Jazz', 'Older Waves']) {
                const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                    trackCount: 1,
                    withEmbeddings: true,
                    genre,
                });
                await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${trackIds[0]}::uuid`;
                await sql`INSERT INTO user_music_state (user_id, track_id, play_count) VALUES (${userId}::uuid, ${trackIds[0]}::uuid, 3)`;
            }
            const mixes = await getMusicSmartMixes(sql, userId, 5, {
                deniedGroupIds: [deniedGroup],
                ageRating: { maxAgeRating: 12, allowUnrated: false },
            });
            expect(mixes.map((mix) => mix.genre)).toEqual(['lunar jazz']);
            expect(mixes[0].tracks.map((track) => track.id)).toEqual(allowedIds);
        });

        it('returns empty array when no listening history', async () => {
            const mixes = await getMusicSmartMixes(sql, userId, 5, {
                deniedGroupIds: null,
                ageRating: null,
            });
            expect(mixes).toEqual([]);
        });
    });

    // ========================================================================
    // getMusicMoodRecommendations
    // ========================================================================

    describe('getMusicMoodRecommendations', () => {
        it('returns tracks matching a mood vector', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
            });

            // Audio-space (MSCLAP) embeddings, matching mood_vectors' 1024-dim
            // vector column.
            for (const trackId of trackIds) {
                const embeddingVector = Array.from({ length: 1024 }, () => Math.random());
                const embeddingVectorString = `[${embeddingVector.join(',')}]`;
                await sql`
                    INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
                    VALUES (${trackId}::uuid, ${MSCLAP_MODEL_ID}, ${embeddingVectorString}::vector)
                `;
            }

            // Insert an MSCLAP mood vector matching the embedding dimension (1024)
            const vector = Array.from({ length: 1024 }, () => Math.random());
            const vectorString = `[${vector.join(',')}]`;
            await sql`
                INSERT INTO mood_vectors (mood_key, display_name, vector, model_id)
                VALUES ('happy', 'Happy', ${vectorString}::vector, ${MSCLAP_MODEL_ID})
            `;

            const results = await getMusicMoodRecommendations(sql, 'happy', 5, {
                deniedGroupIds: null,
                ageRating: null,
            });

            expect(results.length).toBeGreaterThan(0);
            expect(results[0].similarity).toBeDefined();
        });

        it('returns empty array when mood key does not exist', async () => {
            const results = await getMusicMoodRecommendations(sql, 'nonexistent_mood', 5, {
                deniedGroupIds: null,
                ageRating: null,
            });
            expect(results).toEqual([]);
        });

        it('collapses remix/variant titles onto the untagged original (regression)', async () => {
            const moodKey = 'music:chill-mood-rec';
            await seedVariantTitleMoodFixture(sql, moodKey);

            const results = await getMusicMoodRecommendations(sql, moodKey, 10, {
                deniedGroupIds: null,
                ageRating: null,
            });

            const variantRows = results.filter((r) => VARIANT_TITLES.includes(r.title));
            expect(variantRows).toHaveLength(1);
            expect(variantRows[0].title).toBe('Song One');
        });
    });

    // ========================================================================
    // getMusicMoodRecommendations — opt-in keyset cursor (E2)
    // ========================================================================

    describe('getMusicMoodRecommendations — keyset cursor (E2)', () => {
        const MOOD_KEY = 'music:cursor-parity';
        const ACCESS = { deniedGroupIds: null, ageRating: null } as const;

        /**
         * Seed `count` playable tracks — each under its OWN artist/album with a
         * DISTINCT title and a DISTINCT random audio embedding — plus a mood
         * vector. Distinct titles keep every candidate in its own dedup
         * partition (title_rank = 1), so the result is a clean stable order over
         * all tracks: the ideal surface to prove keyset parity.
         */
        async function seedDistinctMoodTracks(count: number): Promise<void> {
            const moodVec = Array.from({ length: 1024 }, () => Math.random());
            await sql`
                INSERT INTO mood_vectors (mood_key, display_name, vector, model_id)
                VALUES (${MOOD_KEY}, 'Cursor Parity', ${`[${moodVec.join(',')}]`}::vector, ${MSCLAP_MODEL_ID})
            `;
            for (let i = 0; i < count; i++) {
                const artist = createTestArtist({
                    title: `Cursor Artist ${i}-${randomUUID().slice(0, 8)}`,
                });
                const album = createTestAlbum(artist.id);
                await insertTestArtist(sql, artist);
                await insertTestAlbum(sql, album);
                const track = createTestTrack(album.id, 1, {
                    title: `Cursor Song ${i}`,
                    custom_metadata: { artist: artist.title, album: album.title },
                });
                await insertTestTrack(sql, track);
                const emb = Array.from({ length: 1024 }, () => Math.random());
                await sql`
                    INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
                    VALUES (${track.id}::uuid, ${MSCLAP_MODEL_ID}, ${`[${emb.join(',')}]`}::vector)
                `;
            }
        }

        it('offset result is unchanged and every row carries an exact distance_cursor', async () => {
            await seedDistinctMoodTracks(5);

            const rows = await getMusicMoodRecommendations(sql, MOOD_KEY, 50, ACCESS);

            expect(rows.length).toBe(5);
            // similarity = 1 - distance, so a distance-ASC order is a
            // similarity-DESC order: monotonic non-increasing.
            for (let i = 1; i < rows.length; i++) {
                expect(rows[i - 1].similarity).toBeGreaterThanOrEqual(rows[i].similarity);
            }
            // Each row exposes an exact float8 text cursor that re-parses cleanly.
            for (const r of rows) {
                expect(typeof r.distance_cursor).toBe('string');
                expect(Number.isNaN(Number(r.distance_cursor))).toBe(false);
            }
        });

        it('cursor paging reproduces the offset order with no dupes or skips (parity)', async () => {
            await seedDistinctMoodTracks(7);

            const baseline = await getMusicMoodRecommendations(sql, MOOD_KEY, 100, ACCESS);
            const baselineIds = baseline.map((r) => r.id);
            expect(baselineIds.length).toBe(7);

            const pageSize = 2;
            const collected: string[] = [];
            let cursor: { distance: string; id: string } | undefined;
            for (let guard = 0; guard < 20; guard++) {
                // Mirror the def: fetch pageSize + 1 to detect hasMore.
                const rows = await getMusicMoodRecommendations(
                    sql,
                    MOOD_KEY,
                    pageSize + 1,
                    ACCESS,
                    cursor ? { cursor } : undefined,
                );
                const page = rows.slice(0, pageSize);
                collected.push(...page.map((r) => r.id));
                if (rows.length <= pageSize) break;
                const last = page[page.length - 1];
                cursor = { distance: last.distance_cursor!, id: last.id };
            }

            expect(collected).toEqual(baselineIds); // same order, complete coverage
            expect(new Set(collected).size).toBe(collected.length); // no dupes
        });

        it('sort precision: two near-equal distances page in the exact offset order', async () => {
            // Two embeddings differing by a tiny epsilon → distinct-but-close
            // distances. Keyset must page them in the exact offset order without
            // dropping either (float8 cursor round-trips losslessly).
            const moodVec = Array.from({ length: 1024 }, () => Math.random());
            await sql`
                INSERT INTO mood_vectors (mood_key, display_name, vector, model_id)
                VALUES (${MOOD_KEY}, 'Precision', ${`[${moodVec.join(',')}]`}::vector, ${MSCLAP_MODEL_ID})
            `;
            const base = [...moodVec];
            const eps = [...moodVec];
            eps[0] += 1e-7;
            for (const [idx, vec] of [base, eps].entries()) {
                const artist = createTestArtist({
                    title: `Prec Artist ${idx}-${randomUUID().slice(0, 8)}`,
                });
                const album = createTestAlbum(artist.id);
                await insertTestArtist(sql, artist);
                await insertTestAlbum(sql, album);
                const track = createTestTrack(album.id, 1, {
                    title: `Prec Song ${idx}`,
                    custom_metadata: { artist: artist.title, album: album.title },
                });
                await insertTestTrack(sql, track);
                await sql`
                    INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
                    VALUES (${track.id}::uuid, ${MSCLAP_MODEL_ID}, ${`[${vec.join(',')}]`}::vector)
                `;
            }

            const baseline = await getMusicMoodRecommendations(sql, MOOD_KEY, 100, ACCESS);
            expect(baseline.length).toBe(2);

            // Page size 1: fetch 2, keep 1, cursor from it, then the next page.
            const page1 = await getMusicMoodRecommendations(sql, MOOD_KEY, 2, ACCESS);
            const first = page1.slice(0, 1);
            const cursor = { distance: first[0].distance_cursor!, id: first[0].id };
            const page2 = await getMusicMoodRecommendations(sql, MOOD_KEY, 2, ACCESS, { cursor });

            expect(first[0].id).toBe(baseline[0].id);
            expect(page2[0].id).toBe(baseline[1].id);
        });
    });

    describe('getMoodShelfTracks', () => {
        it('applies the taste boost without a CASE type error (regression)', async () => {
            // Regression: `CASE WHEN … THEN ${0.04} ELSE 0 END` let Postgres
            // resolve the CASE to integer (untyped param + integer 0), so the
            // query failed to parse — every mood shelf 503'd, even with data.
            // The parse error fires regardless of row count, so seeding a
            // played artist is not required to cover it — but seed anyway so
            // the boost branch is exercised end-to-end.
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
            });
            for (const trackId of trackIds) {
                const embeddingVector = Array.from({ length: 1024 }, () => Math.random());
                const embeddingVectorString = `[${embeddingVector.join(',')}]`;
                await sql`
                    INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
                    VALUES (${trackId}::uuid, ${MSCLAP_MODEL_ID}, ${embeddingVectorString}::vector)
                `;
            }
            await ensureTestUser(sql, userId);
            await sql`
                INSERT INTO user_music_state (user_id, track_id, play_count)
                VALUES (${userId}, ${trackIds[0]}, 3)
            `;

            const vector = Array.from({ length: 1024 }, () => Math.random());
            const vectorString = `[${vector.join(',')}]`;
            await sql`
                INSERT INTO mood_vectors (mood_key, display_name, vector, model_id)
                VALUES ('music:party', 'Party', ${vectorString}::vector, ${MSCLAP_MODEL_ID})
            `;

            const results = await getMoodShelfTracks(sql, userId, 'music:party', 5, {
                deniedGroupIds: null,
                ageRating: null,
            });

            expect(results.length).toBeGreaterThan(0);
        });

        it('returns empty array when the mood key does not exist', async () => {
            const results = await getMoodShelfTracks(sql, userId, 'music:nonexistent', 5, {
                deniedGroupIds: null,
                ageRating: null,
            });
            expect(results).toEqual([]);
        });

        it('returns empty array when no MSCLAP mood vector exists, even if a text-space vector and embeddings do (audio-only gate)', async () => {
            // "Mood sections only make sense with the CLAP thingy and should
            // ONLY show with real mood data" — a text-space (model_id='text')
            // mood_vectors row, plus text-space media_embeddings, must NOT
            // produce a fallback match once no MSCLAP mood vector exists.
            const moodKey = 'music:text-only-no-msclap';
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
                withEmbeddings: true,
            });
            await ensureTestUser(sql, userId);
            await sql`
                INSERT INTO user_music_state (user_id, track_id, play_count)
                VALUES (${userId}, ${trackIds[0]}, 3)
            `;

            const vector = Array.from({ length: 1024 }, () => Math.random());
            const vectorString = `[${vector.join(',')}]`;
            await sql`
                INSERT INTO mood_vectors (mood_key, display_name, vector, model_id)
                VALUES (${moodKey}, 'Text Only', ${vectorString}::vector, 'text')
            `;

            const results = await getMoodShelfTracks(sql, userId, moodKey, 5, {
                deniedGroupIds: null,
                ageRating: null,
            });

            expect(results).toEqual([]);
        });

        it('collapses remix/variant titles onto the untagged original (regression)', async () => {
            const moodKey = 'music:chill-shelf';
            await seedVariantTitleMoodFixture(sql, moodKey);

            const results = await getMoodShelfTracks(sql, userId, moodKey, 10, {
                deniedGroupIds: null,
                ageRating: null,
            });

            const variantRows = results.filter((r) => VARIANT_TITLES.includes(r.title));
            expect(variantRows).toHaveLength(1);
            expect(variantRows[0].title).toBe('Song One');
        });

        it('does not collapse same-titled tracks under the Various Artists branch', async () => {
            // The Various-Artists partition key is 'va:' || track id, so two
            // identically-titled compilation tracks must both survive —
            // unlike the non-VA branch, this partitioning never depended on
            // the trailing-variant-segment regex, so it was unaffected by the
            // d1fe342e2 bug. Covered here for completeness alongside the
            // dedup regression above.
            //
            // The exemption is now driven by the is_various_artists flag (Task
            // 7), not by a LOWER(artist_title) = 'various artists' name
            // compare, so the flag must be set explicitly on the fixture —
            // createTestArtist does not set it.
            const moodKey = 'music:chill-va';
            const sharedVector = Array.from({ length: 1024 }, () => Math.random());
            const sharedVectorString = `[${sharedVector.join(',')}]`;

            await sql`
                INSERT INTO mood_vectors (mood_key, display_name, vector, model_id)
                VALUES (${moodKey}, 'Test Mood VA', ${sharedVectorString}::vector, ${MSCLAP_MODEL_ID})
            `;

            const vaArtist = createTestArtist({ title: 'Various Artists' });
            const vaAlbum = createTestAlbum(vaArtist.id);
            await insertTestArtist(sql, vaArtist);
            await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${vaArtist.id}::uuid`;
            await insertTestAlbum(sql, vaAlbum);

            for (let index = 0; index < 2; index++) {
                const track = createTestTrack(vaAlbum.id, index + 1, {
                    title: 'Compilation Cut',
                    custom_metadata: { artist: '', album: vaAlbum.title },
                });
                await insertTestTrack(sql, track);
                await sql`
                    INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
                    VALUES (${track.id}::uuid, ${MSCLAP_MODEL_ID}, ${sharedVectorString}::vector)
                `;
            }

            const results = await getMoodShelfTracks(sql, userId, moodKey, 10, {
                deniedGroupIds: null,
                ageRating: null,
            });

            const vaRows = results.filter((r) => r.artist_title === 'Various Artists');
            expect(vaRows).toHaveLength(2);
        });

        it('exempts a flagged foreign-titled VA bucket from the cap (flag-driven, not name-driven)', async () => {
            // Regression for the Task 7 swap: a VA artist whose title has not
            // (yet) been normalized to the canonical "Various Artists" label
            // — e.g. a foreign-language alias bucket mid-merge — must still be
            // exempted from the per-artist cap purely because it carries the
            // is_various_artists flag. Name-based detection would have missed
            // this case.
            const moodKey = 'music:chill-va-foreign';
            const sharedVector = Array.from({ length: 1024 }, () => Math.random());
            const sharedVectorString = `[${sharedVector.join(',')}]`;

            await sql`
                INSERT INTO mood_vectors (mood_key, display_name, vector, model_id)
                VALUES (${moodKey}, 'Test Mood VA Foreign', ${sharedVectorString}::vector, ${MSCLAP_MODEL_ID})
            `;

            const vaArtist = createTestArtist({ title: 'Verschiedene Interpreten' });
            const vaAlbum = createTestAlbum(vaArtist.id);
            await insertTestArtist(sql, vaArtist);
            await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${vaArtist.id}::uuid`;
            await insertTestAlbum(sql, vaAlbum);

            for (let index = 0; index < 2; index++) {
                const track = createTestTrack(vaAlbum.id, index + 1, {
                    title: 'Foreign Compilation Cut',
                    custom_metadata: { artist: '', album: vaAlbum.title },
                });
                await insertTestTrack(sql, track);
                await sql`
                    INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
                    VALUES (${track.id}::uuid, ${MSCLAP_MODEL_ID}, ${sharedVectorString}::vector)
                `;
            }

            const results = await getMoodShelfTracks(sql, userId, moodKey, 10, {
                deniedGroupIds: null,
                ageRating: null,
            });

            const vaRows = results.filter((r) => r.artist_title === 'Verschiedene Interpreten');
            expect(vaRows).toHaveLength(2);
        });
    });

    // ========================================================================
    // getNewForYouTracks — differential access boundary
    // ========================================================================

    describe('getNewForYouTracks — access boundary is honoured (differential)', () => {
        // Per the access-boundary design spec, the query is run three ways over
        // one fixture:
        //   1. unrestrictedAccess() — POSITIVE CONTROL. Must be non-empty; this
        //      proves the fixture is reachable and the SQL runs (an unfiltered
        //      read is the only way to know a later empty result is the boundary
        //      working rather than a swallowed error / empty fixture).
        //   2. a denyGroups() boundary — must be a STRICT SUBSET of (1).
        //   3. denyAllAccess() — must be EMPTY (short-circuits before the query).
        it('library scope hides denied-group tracks, denyAll returns empty', async () => {
            const groupA = await createLibraryGroup(sql, `NFY Group A ${randomUUID().slice(0, 8)}`);
            const groupB = await createLibraryGroup(sql, `NFY Group B ${randomUUID().slice(0, 8)}`);

            // Two freshly-added, never-played tracks (the fixture inserts each
            // with created_at = NOW(), so they fall inside `sinceDays`, and no
            // user_music_state row exists for `userId`, so play_count IS NULL).
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
                withEmbeddings: false,
            });
            const [trackInA, trackInB] = trackIds;
            await moveTrackFileToGroup(sql, trackInA, groupA);
            await moveTrackFileToGroup(sql, trackInB, groupB);

            const run = (access: MediaAccessBoundary): Promise<string[]> =>
                getNewForYouTracks(sql, userId, [], 50, { access, sinceDays: 30 }).then((rows) =>
                    rows.map((r) => r.id),
                );

            const open = await run(unrestrictedAccess());
            // POSITIVE CONTROL — a swallowed error or unreachable fixture would
            // surface here as an empty set.
            expect(open.length).toBeGreaterThan(0);
            expect(open).toContain(trackInA);
            expect(open).toContain(trackInB);

            const narrowed = await run(denyGroups(groupA));
            // STRICT SUBSET: nothing new appears, and the denied-group track is
            // gone while the allowed-group track survives.
            const openSet = new Set(open);
            expect(narrowed.every((id) => openSet.has(id))).toBe(true);
            expect(narrowed.length).toBeLessThan(open.length);
            expect(narrowed).not.toContain(trackInA);
            expect(narrowed).toContain(trackInB);

            const denied = await run(denyAllAccess());
            expect(denied).toEqual([]);
        });
    });
});
