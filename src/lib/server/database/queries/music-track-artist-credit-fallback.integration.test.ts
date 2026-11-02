// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional.
 * Read paths for canonical `track_artist_credits`: an EMPTY list falls back to
 * the album artist like a missing key, and Various Artists is never a
 * performer or an artist link target.
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
import { toMusicTrack } from '../../services/music/track-projection.js';

describe('track_artist_credits read paths — empty list and Various Artists', () => {
    let sql: postgres.Sql;
    const USER = toUserId(randomUUID());

    let ownerId: string;
    let vaId: string;
    let performerId: string;
    let seedTrackId: string;
    let ownerAlbumId: string;
    let vaAlbumId: string;
    const ids = {} as Record<'empty' | 'missing' | 'vaPerformer' | 'vaOnly', string>;

    beforeAll(async () => {
        sql = getTestDb();
        await sql.unsafe(
            'TRUNCATE TABLE media_embeddings, media_file_items, media_files, watch_history, media_items CASCADE',
        );
        await sql`
            INSERT INTO users (id, username)
            VALUES (${USER}::uuid, ${derivedUsername(USER)})
            ON CONFLICT (id) DO NOTHING
        `;

        const owner = createTestArtist({ title: 'Album Owner' });
        await insertTestArtist(sql, owner);
        ownerId = owner.id;
        const va = createTestArtist({ title: 'Various Artists' });
        await insertTestArtist(sql, va);
        vaId = va.id;
        await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${vaId}::uuid`;
        const performer = createTestArtist({ title: 'Real Performer' });
        await insertTestArtist(sql, performer);
        performerId = performer.id;

        const ownerAlbum = createTestAlbum(ownerId, { title: 'Owner Album' });
        await insertTestAlbum(sql, ownerAlbum);
        ownerAlbumId = ownerAlbum.id;
        const vaAlbum = createTestAlbum(vaId, { title: 'Compilation' });
        await insertTestAlbum(sql, vaAlbum);
        vaAlbumId = vaAlbum.id;

        const mk = async (
            key: keyof typeof ids,
            albumId: string,
            n: number,
            custom_metadata: Record<string, unknown>,
        ) => {
            const t = createTestTrack(albumId, n, { title: `Track ${key}`, custom_metadata });
            await insertTestTrack(sql, t);
            ids[key] = t.id;
        };
        await mk('empty', ownerAlbumId, 1, { track_artist_credits: [] });
        await mk('missing', ownerAlbumId, 2, { artist: 'Album Owner' });
        await mk('vaPerformer', vaAlbumId, 1, {
            track_artist_credits: [
                { id: vaId, credited_name: 'Various Artists' },
                { id: performerId, credited_name: 'Real Performer' },
            ],
        });
        await mk('vaOnly', vaAlbumId, 2, {
            track_artist_credits: [{ id: null, credited_name: 'Various Artists' }],
        });

        const seedArtist = createTestArtist({ title: 'Seed Artist' });
        await insertTestArtist(sql, seedArtist);
        const seedAlbum = createTestAlbum(seedArtist.id, { title: 'Seed Album' });
        await insertTestAlbum(sql, seedAlbum);
        const seed = createTestTrack(seedAlbum.id, 9, { title: 'Seed Track' });
        await insertTestTrack(sql, seed);
        seedTrackId = seed.id;

        for (const id of [seedTrackId, ...Object.values(ids)]) {
            await sql`
                INSERT INTO media_embeddings (media_id, source, embedding)
                VALUES (${id}::uuid, 'music', ${musicFixtureEmbeddingLiteral()}::vector)
            `;
        }
    });

    afterAll(async () => {
        await closeTestDb();
    });

    describe('getTrackDetail', () => {
        it('empty credits fall back to the album artist', async () => {
            const row = await getTrackDetail(sql, ids.empty);
            expect(row?.artist_title).toBe('Album Owner');
            expect(row?.artist_id).toBe(ownerId);
        });

        it('missing key keeps the legacy resolution', async () => {
            const row = await getTrackDetail(sql, ids.missing);
            expect(row?.artist_title).toBe('Album Owner');
            expect(row?.artist_id).toBe(ownerId);
        });

        it('VA compilation track shows the real performer, not Various Artists', async () => {
            const row = await getTrackDetail(sql, ids.vaPerformer);
            expect(row?.artist_title).toBe('Real Performer');
            expect(row?.artist_id).toBe(performerId);
            expect(row?.track_artists).toEqual([{ id: performerId, title: 'Real Performer' }]);
        });

        it('VA-only credit yields no performer and never the VA id', async () => {
            const row = await getTrackDetail(sql, ids.vaOnly);
            expect(row?.artist_title ?? null).not.toBe('Various Artists');
            expect(row?.artist_id ?? null).toBeNull();
            expect(row?.track_artists).toEqual([]);
        });
    });

    describe('getAlbumWithTracks', () => {
        it('owner album: empty and missing credits show the album artist', async () => {
            const album = await getAlbumWithTracks(sql, ownerAlbumId);
            const byId = new Map(album?.tracks.map((t) => [t.id, t]));
            for (const key of ['empty', 'missing'] as const) {
                const t = byId.get(ids[key]);
                expect(t?.track_artist_title, key).toBe('Album Owner');
                expect(t?.track_artist_id, key).toBe(ownerId);
                // What the album page sends: the owner, never "Unknown Artist".
                expect(t && toMusicTrack(t, {}).artists, key).toEqual([
                    { id: ownerId, title: 'Album Owner' },
                ]);
            }
        });

        it('compilation: performer shown, VA never a performer', async () => {
            const album = await getAlbumWithTracks(sql, vaAlbumId);
            const byId = new Map(album?.tracks.map((t) => [t.id, t]));
            const withPerformer = byId.get(ids.vaPerformer);
            expect(withPerformer?.track_artist_title).toBe('Real Performer');
            expect(withPerformer?.track_artist_id).toBe(performerId);
            const vaOnly = byId.get(ids.vaOnly);
            expect(vaOnly?.track_artist_title ?? null).toBeNull();
            expect(vaOnly?.track_artist_id ?? null).toBeNull();
        });
    });

    describe('queue candidates', () => {
        async function candidate(id: string) {
            const rows = await getSmartQueueCandidates(sql, seedTrackId, [], 50, { userId: USER });
            return rows.find((r) => r.id === id);
        }

        it('empty credits resolve to the album artist', async () => {
            const row = await candidate(ids.empty);
            expect(row?.resolved_artist).toBe('Album Owner');
            expect(row?.resolved_artist_id).toBe(ownerId);
        });

        it('missing key resolves to the album artist', async () => {
            const row = await candidate(ids.missing);
            expect(row?.resolved_artist).toBe('Album Owner');
            expect(row?.resolved_artist_id).toBe(ownerId);
        });

        it('VA compilation track resolves to the performer', async () => {
            const row = await candidate(ids.vaPerformer);
            expect(row?.resolved_artist).toBe('Real Performer');
            expect(row?.resolved_artist_id).toBe(performerId);
        });

        it('VA-only credit never yields the VA id or label', async () => {
            const row = await candidate(ids.vaOnly);
            expect(row?.resolved_artist_id ?? null).toBeNull();
            expect(row?.resolved_artist).not.toBe('Various Artists');
        });
    });
});
