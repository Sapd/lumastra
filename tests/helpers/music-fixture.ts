// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Make the seeded music tracks streamable, whatever ran before this spec.
 *
 * global-setup.ts seeds the artist/album/tracks and their `media_files` link
 * while the dev server is already up. On a FRESH database the server's first
 * library scan and has-files recompute finish around the same time and drop
 * those rows again: `has_files` goes false and the `media_files` row is gone,
 * so `/api/music/tracks/<id>/stream` answers 404 "Audio file path not
 * available". A spec that really loads audio then ends in a MediaError and the
 * player drops the track. On a database that was already scanned (a local
 * re-run) the rows survive, which is why this only showed up in CI.
 *
 * Idempotent, same statements as global-setup.ts. Call it from `beforeAll`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { MusicTrack } from '../../src/lib/schemas/music';
import {
    TEST_MUSIC_ALBUM_ID,
    TEST_MUSIC_ARTIST_ID,
    TEST_MUSIC_TRACK_2_ID,
    TEST_MUSIC_TRACK_ID,
} from '../global-setup';

const TRACK_FILE = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../fixtures/music/sample.flac',
);

export async function ensureSeededMusicStreamable(): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required to re-link the music fixture');
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
    try {
        const fileRows = await sql<[{ id: string }]>`
            INSERT INTO media_files (file_path)
            VALUES (${TRACK_FILE})
            ON CONFLICT (file_path) DO UPDATE SET updated_at = NOW()
            RETURNING id
        `;
        const fileId = fileRows[0]?.id;
        if (!fileId) throw new Error('could not upsert the music fixture media_files row');
        for (const trackId of [TEST_MUSIC_TRACK_ID, TEST_MUSIC_TRACK_2_ID]) {
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}, ${trackId})
                ON CONFLICT DO NOTHING
            `;
        }
        await sql`
            UPDATE media_items
            SET has_files = TRUE, status = 'active', updated_at = NOW()
            WHERE id IN (${TEST_MUSIC_ARTIST_ID}, ${TEST_MUSIC_ALBUM_ID},
                         ${TEST_MUSIC_TRACK_ID}, ${TEST_MUSIC_TRACK_2_ID})
        `;
    } finally {
        await sql.end();
    }
}

/** Canonical music projection, shared by browser mocks and injected tracks. */
export const SEEDED_MUSIC_TRACK = {
    id: TEST_MUSIC_TRACK_ID,
    type: 'track',
    title: 'Test Track 01',
    artists: [{ id: TEST_MUSIC_ARTIST_ID, title: 'Test Artist' }],
    albumArtist: { id: TEST_MUSIC_ARTIST_ID, title: 'Test Artist' },
    album: { id: TEST_MUSIC_ALBUM_ID, title: 'Test Album' },
    durationMs: 10_000,
    trackNumber: null,
    discNumber: null,
    genres: [],
    year: null,
    images: {},
    isRadio: false,
} satisfies MusicTrack;
