// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Stations Service — station label resolution.
 *
 * `getUserStations` requires a real k-means clustering fixture
 * (MIN_PLAYS_FOR_CLUSTERING = 10 real plays + embeddings), which is
 * impractical to seed for a targeted VA-exclusion test. `resolveStationLabel`
 * takes a `TasteCluster` directly (just `sampleTrackIds` matters for label
 * resolution), so it's exported from stations.service.ts for exactly this
 * purpose and exercised directly here against a real database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import { resolveStationLabel } from './stations.service.js';
import type { TasteCluster } from './taste-clusters.service.js';

describe('resolveStationLabel (real DB)', () => {
    let sql: postgres.Sql;
    const userId: UserId = toUserId(randomUUID());

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.userData, ...TEST_TABLES.media]);
        await ensureTestUser(sql, userId);
    });

    it('labels the station after the ordinary artist, never the flagged VA artist, even when VA has more plays', async () => {
        // Ordinary artist track — fewer plays.
        const ordinaryArtist = createTestArtist({ title: 'Station Ordinary Artist' });
        await insertTestArtist(sql, ordinaryArtist);
        const ordinaryAlbum = createTestAlbum(ordinaryArtist.id);
        await insertTestAlbum(sql, ordinaryAlbum);
        const ordinaryTrack = createTestTrack(ordinaryAlbum.id, 1);
        await insertTestTrack(sql, ordinaryTrack);

        // VA artist track — deliberately MORE plays, so if the VA exclusion
        // regressed to a no-op, this track would dominate the label instead.
        const vaArtist = createTestArtist({ title: 'Station Various Artists' });
        await insertTestArtist(sql, vaArtist);
        await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${vaArtist.id}::uuid`;
        const vaAlbum = createTestAlbum(vaArtist.id);
        await insertTestAlbum(sql, vaAlbum);
        const vaTrack = createTestTrack(vaAlbum.id, 1);
        await insertTestTrack(sql, vaTrack);

        await sql`
            INSERT INTO user_music_state (user_id, track_id, play_count)
            VALUES (${userId}, ${ordinaryTrack.id}, 3)
        `;
        await sql`
            INSERT INTO user_music_state (user_id, track_id, play_count)
            VALUES (${userId}, ${vaTrack.id}, 50)
        `;

        const cluster: TasteCluster = {
            centroid: [],
            size: 2,
            sampleTrackIds: [ordinaryTrack.id, vaTrack.id],
        };

        const label = await resolveStationLabel(sql, userId, cluster, 0);

        expect(label).toBe(ordinaryArtist.title);
    });

    it('falls back to "Station N" when the only sample track belongs to a flagged VA artist', async () => {
        const vaArtist = createTestArtist({ title: 'Only Various Artists' });
        await insertTestArtist(sql, vaArtist);
        await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${vaArtist.id}::uuid`;
        const vaAlbum = createTestAlbum(vaArtist.id);
        await insertTestAlbum(sql, vaAlbum);
        const vaTrack = createTestTrack(vaAlbum.id, 1);
        await insertTestTrack(sql, vaTrack);

        const cluster: TasteCluster = {
            centroid: [],
            size: 1,
            sampleTrackIds: [vaTrack.id],
        };

        const label = await resolveStationLabel(sql, userId, cluster, 2);

        expect(label).toBe('Station 3');
    });
});
