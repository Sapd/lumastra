// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for music-quick-picks Query Module
 *
 * Verifies that every bucket query correctly projects the `hours_since_played`
 * column — both its presence and its runtime type. TypeScript cannot catch a
 * missing `AS hours_since_played` or a missing `::double precision` cast at
 * compile time, so these tests guard against silent regressions that would
 * disable the recency penalty in the sampler.
 *
 * Requires a running test DB: TEST_DATABASE_URL env var.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
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
import type { RecentTrackRow } from './music.queries.js';
import {
    getMostPlayedTracks,
    getHotThisWeek,
    getHighlyRatedTracks,
    getDeepCutTracks,
    getRandomTracks,
    getTasteSimilarTracks,
} from './music-quick-picks.queries.js';

// =============================================================================
// Helper
// =============================================================================

/**
 * Asserts every row carries a valid `hours_since_played` projection:
 * either `null` (LEFT JOIN miss) or a finite JS number — never a string,
 * never `undefined`. String indicates the SQL missed `::double precision`;
 * undefined indicates the SELECT omitted the column entirely.
 */
function expectHoursSincePlayedShape(rows: RecentTrackRow[]): void {
    for (const row of rows) {
        expect(row).toHaveProperty('hours_since_played');
        if (row.hours_since_played !== null) {
            expect(typeof row.hours_since_played).toBe('number');
            expect(Number.isFinite(row.hours_since_played)).toBe(true);
        }
    }
}

// =============================================================================
// Quick-picks bucket queries — hours_since_played projection
// =============================================================================

describe('quick-picks queries — hours_since_played projection', () => {
    let sql: postgres.Sql;
    const USER: UserId = toUserId(randomUUID());

    // IDs set up in beforeAll fixture
    let albumId: string;
    let trackIdPlayed30m: string;
    let trackIdPlayed3h: string;
    let trackIdPlayed30h: string;
    let trackIdNeverPlayed: string;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        // Same clear as beforeEach: this file only cleaned on the way IN, so
        // the last test's fixture rows (plus the 120 sampling-pad tracks) were
        // left behind in the shared lumastra_tests DB for whatever file ran
        // next.
        await sql.unsafe(
            'TRUNCATE TABLE media_embeddings, media_file_items, media_files, watch_history, media_items CASCADE',
        );
        await sql`DELETE FROM user_music_state WHERE user_id = ${USER}::uuid`;
        await sql`DELETE FROM user_ratings WHERE user_id = ${USER}::uuid`;
        await closeTestDb();
    });

    beforeEach(async () => {
        // Clear music-related tables for test isolation
        await sql.unsafe(
            'TRUNCATE TABLE media_embeddings, media_file_items, media_files, watch_history, media_items CASCADE',
        );

        // Ensure user exists (users + user_profiles for FK chain)
        await sql`
            INSERT INTO users (id, username)
            VALUES (${USER}::uuid, ${derivedUsername(USER)})
            ON CONFLICT (id) DO NOTHING
        `;
        await sql`
            INSERT INTO user_profiles (user_id)
            VALUES (${USER}::uuid)
            ON CONFLICT (user_id) DO NOTHING
        `;
        await sql`DELETE FROM user_music_state WHERE user_id = ${USER}::uuid`;
        await sql`DELETE FROM user_ratings WHERE user_id = ${USER}::uuid`;

        // Build fixture hierarchy
        const artist = createTestArtist({ title: 'Quick Picks Artist' });
        await insertTestArtist(sql, artist);
        const album = createTestAlbum(artist.id, {
            title: 'Quick Picks Album',
        });
        await insertTestAlbum(sql, album);
        albumId = album.id;

        // Every track below carries an explicit genre tag.
        // quickPickQualityFilter (music-quick-picks.queries.ts) requires
        // `custom_metadata.genre` to be a non-empty array for the buckets
        // ranked on media_embeddings (getTasteSimilarTracks among them) — a
        // deliberate, prod-measured gate against genre-less/badly-tagged
        // rips, not an oversight. createTestTrack's own default
        // custom_metadata carries no `genre` key at all, so leaving it at
        // that default makes every track here fail the gate and every
        // gated bucket return zero rows regardless of embeddings or play
        // history — which is what silently sank
        // "getTasteSimilarTracks projects hours_since_played when
        // embeddings exist" below.
        const genreMetadata = { genre: ['Electronic'] };

        // Track played 30 minutes ago
        const t30m = createTestTrack(album.id, 1, {
            title: 'Played 30min Ago',
            custom_metadata: genreMetadata,
        });
        await insertTestTrack(sql, t30m);
        trackIdPlayed30m = t30m.id;

        // Track played 3 hours ago
        const t3h = createTestTrack(album.id, 2, {
            title: 'Played 3h Ago',
            custom_metadata: genreMetadata,
        });
        await insertTestTrack(sql, t3h);
        trackIdPlayed3h = t3h.id;

        // Track played 30 hours ago
        const t30h = createTestTrack(album.id, 3, {
            title: 'Played 30h Ago',
            custom_metadata: genreMetadata,
        });
        await insertTestTrack(sql, t30h);
        trackIdPlayed30h = t30h.id;

        // Track never played — will produce null hours_since_played
        const tNever = createTestTrack(album.id, 4, {
            title: 'Never Played',
            custom_metadata: genreMetadata,
        });
        await insertTestTrack(sql, tNever);
        trackIdNeverPlayed = tNever.id;

        // Insert user_music_state rows for played tracks
        for (const [id, interval] of [
            [trackIdPlayed30m, '30 minutes'],
            [trackIdPlayed3h, '3 hours'],
            [trackIdPlayed30h, '30 hours'],
        ] as [string, string][]) {
            await sql`
                INSERT INTO user_music_state (user_id, track_id, play_count, last_played_at)
                VALUES (
                    ${USER}::uuid,
                    ${id}::uuid,
                    3,
                    NOW() - ${interval}::interval
                )
            `;
        }
    });

    // =========================================================================
    // getMostPlayedTracks
    // =========================================================================

    it('getMostPlayedTracks projects hours_since_played', async () => {
        const rows = await getMostPlayedTracks(sql, USER, 10);
        expect(rows.length).toBeGreaterThan(0);
        expectHoursSincePlayedShape(rows);
    });

    it('getMostPlayedTracks returns hours_since_played ≈ 3 for a 3h-old play', async () => {
        const rows = await getMostPlayedTracks(sql, USER, 10);
        const row = rows.find((r) => r.id === trackIdPlayed3h);
        expect(row).toBeDefined();
        expect(row!.hours_since_played).not.toBeNull();
        expect(row!.hours_since_played).toBeGreaterThan(2.9);
        expect(row!.hours_since_played).toBeLessThan(3.1);
    });

    // =========================================================================
    // getHotThisWeek
    // =========================================================================

    it('getHotThisWeek projects hours_since_played', async () => {
        // getHotThisWeek is driven by non-skipped music_listen_events rows inside
        // the window (the `weekly_plays` CTE). hours_since_played is still
        // projected from user_music_state.last_played_at (seeded in beforeEach
        // for trackIdPlayed3h), so a single listen event surfaces the track.
        await sql`
            INSERT INTO music_listen_events (
                user_id, track_id, was_skipped, was_completed, duration_ms, created_at
            ) VALUES (
                ${USER}::uuid, ${trackIdPlayed3h}::uuid, false, true, 180000,
                NOW() - INTERVAL '3 hours'
            )
        `;

        const rows = await getHotThisWeek(sql, USER, 7, 10);
        expect(rows.length).toBeGreaterThan(0);
        expectHoursSincePlayedShape(rows);
        expect(rows.some((r) => r.id === trackIdPlayed3h)).toBe(true);
    });

    it('getHotThisWeek excludes skipped listen events', async () => {
        // Only a skipped event for this track — weekly_plays should ignore it.
        await sql`
            INSERT INTO music_listen_events (
                user_id, track_id, was_skipped, was_completed, duration_ms, created_at
            ) VALUES (
                ${USER}::uuid, ${trackIdPlayed3h}::uuid, true, false, 4000,
                NOW() - INTERVAL '2 hours'
            )
        `;

        const rows = await getHotThisWeek(sql, USER, 7, 10);
        expect(rows.some((r) => r.id === trackIdPlayed3h)).toBe(false);
    });

    // =========================================================================
    // getHighlyRatedTracks
    // =========================================================================

    it('getHighlyRatedTracks projects hours_since_played', async () => {
        // Insert a rating >= 8 to satisfy the query's WHERE clause
        await sql`
            INSERT INTO user_ratings (user_id, media_id, rating)
            VALUES (${USER}::uuid, ${trackIdPlayed3h}::uuid, 9)
            ON CONFLICT (user_id, media_id) DO UPDATE SET rating = EXCLUDED.rating
        `;

        const rows = await getHighlyRatedTracks(sql, USER, 8, 10);
        expect(rows.length).toBeGreaterThan(0);
        expectHoursSincePlayedShape(rows);
    });

    // =========================================================================
    // getDeepCutTracks
    // =========================================================================

    it('getDeepCutTracks projects hours_since_played', async () => {
        const rows = await getDeepCutTracks(sql, USER, 10);
        expect(rows.length).toBeGreaterThan(0);
        expectHoursSincePlayedShape(rows);
    });

    it('getDeepCutTracks returns hours_since_played === null for never-played track', async () => {
        const rows = await getDeepCutTracks(sql, USER, 40);
        const row = rows.find((r) => r.id === trackIdNeverPlayed);
        expect(row).toBeDefined();
        // LEFT JOIN miss — user has no user_music_state row for this track
        expect(row!.hours_since_played).toBeNull();
    });

    // =========================================================================
    // getRandomTracks
    // =========================================================================

    it('getRandomTracks projects hours_since_played', async () => {
        // getRandomTracks reads `FROM media_items mi TABLESAMPLE BERNOULLI(20)`,
        // which admits each candidate row with probability 0.2. Against the
        // 4-track shared fixture that makes an EMPTY result the common case —
        // P(empty) = 0.8^4 ≈ 41% in theory, and 33/60 independent trials
        // measured empty on this very database. That is why this test failed
        // only inside a full-suite run and passed in isolation: it was a coin
        // flip, not an ordering problem.
        //
        // Padding the sample space to 4 + PAD rows drops P(empty) to
        // 0.8^124 ≈ 6e-13, so the shape assertion below is actually reached.
        // Asserting non-empty matters: expectHoursSincePlayedShape iterates
        // rows, so on an empty result it is a no-op and the test would pass
        // even if the SELECT had dropped `hours_since_played` entirely.
        const PAD = 120;
        const padded = Array.from({ length: PAD }, (_, i) =>
            createTestTrack(albumId, i + 5, { title: `Sample Pad ${i}` }),
        );
        for (const track of padded) {
            await insertTestTrack(sql, track);
        }

        const rows = await getRandomTracks(sql, USER, 10);
        expect(rows.length).toBeGreaterThan(0);
        expectHoursSincePlayedShape(rows);
    });

    // =========================================================================
    // getTasteSimilarTracks
    // =========================================================================

    it('getTasteSimilarTracks projects hours_since_played', async () => {
        // Embeddings are required for results — we add them here, but the
        // taste profile CTE may still be empty if no played tracks have
        // embeddings. Accept 0 rows; the shape helper is a no-op on empty.
        const rows = await getTasteSimilarTracks(sql, USER, [], 10);
        expectHoursSincePlayedShape(rows);
    });

    it('getTasteSimilarTracks projects hours_since_played when embeddings exist', async () => {
        // Seed embeddings for played tracks so the taste CTE is non-null
        // Non-degenerate on purpose — see musicFixtureEmbeddingLiteral: an
        // all-zero vector yields NaN cosine distance, which the HNSW index
        // scan drops entirely.
        const vectorString = musicFixtureEmbeddingLiteral();
        for (const id of [
            trackIdPlayed30m,
            trackIdPlayed3h,
            trackIdPlayed30h,
            trackIdNeverPlayed,
        ]) {
            await sql`
                INSERT INTO media_embeddings (media_id, source, embedding)
                VALUES (${id}::uuid, 'music', ${vectorString}::vector)
                ON CONFLICT DO NOTHING
            `;
        }

        const rows = await getTasteSimilarTracks(sql, USER, [], 10);
        // With embeddings and play history we expect at least 1 result
        expect(rows.length).toBeGreaterThan(0);
        expectHoursSincePlayedShape(rows);
    });
});
