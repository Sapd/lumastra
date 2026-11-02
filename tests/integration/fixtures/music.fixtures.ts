// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Test Fixtures
 *
 * Factory functions for creating music hierarchy test data:
 *   Artist (artist) → Album (album) → Track (track)
 *
 * All data is hallucinated to avoid conflicts with real production data.
 */

import type { Sql } from 'postgres';
import { createTestEmbedding } from './media.fixtures.js';

// =============================================================================
// Types
// =============================================================================

export interface TestMusicArtist {
    id: string;
    title: string;
    media_type: 'artist';
    parent_id: null;
    custom_metadata: Record<string, unknown>;
}

export interface TestMusicAlbum {
    id: string;
    title: string;
    media_type: 'album';
    parent_id: string;
    year: number | null;
    custom_metadata: Record<string, unknown>;
}

export interface TestMusicTrack {
    id: string;
    title: string;
    media_type: 'track';
    parent_id: string;
    sort_order: number;
    runtime_seconds: number;
    custom_metadata: Record<string, unknown>;
}

// =============================================================================
// Sample Data
// =============================================================================

export const SAMPLE_MUSIC_ARTISTS = [
    { title: 'Neon Pulse', genres: ['Electronic', 'Synthwave'] },
    { title: 'The Glass Orchids', genres: ['Indie Rock', 'Dream Pop'] },
    { title: 'Cobalt Meridian', genres: ['Jazz', 'Fusion'] },
] as const;

export const SAMPLE_MUSIC_ALBUMS = [
    { title: 'Digital Horizons', year: 2025, genre: 'Electronic' },
    { title: 'Crystal Waves', year: 2024, genre: 'Synthwave' },
    { title: 'Autumn Frequencies', year: 2023, genre: 'Indie Rock' },
] as const;

export const SAMPLE_MUSIC_TRACKS = [
    {
        title: 'Midnight Circuit',
        bpm: 128,
        key: 'Am',
        scale: 'minor',
        energy: 0.82,
        danceability: 0.85,
        runtime: 210,
    },
    {
        title: 'Starlight Protocol',
        bpm: 120,
        key: 'C',
        scale: 'major',
        energy: 0.65,
        danceability: 0.7,
        runtime: 195,
    },
    {
        title: 'Vapor Trail',
        bpm: 135,
        key: 'G',
        scale: 'major',
        energy: 0.9,
        danceability: 0.92,
        runtime: 240,
    },
    {
        title: 'Echoes in Glass',
        bpm: 95,
        key: 'Em',
        scale: 'minor',
        energy: 0.45,
        danceability: 0.3,
        runtime: 300,
    },
] as const;

// =============================================================================
// Factory Functions
// =============================================================================

export function createTestArtist(overrides: Partial<TestMusicArtist> = {}): TestMusicArtist {
    const sample = SAMPLE_MUSIC_ARTISTS[Math.floor(Math.random() * SAMPLE_MUSIC_ARTISTS.length)];
    return {
        id: overrides.id || crypto.randomUUID(),
        // Append a unique suffix to the default name so two fixtures in one test
        // can't collide on uq_music_artist_norm_title (migration 16.77.0). The
        // hex suffix survives the index's normalization (alphanumerics kept).
        // Explicit `overrides.title` is still honored verbatim.
        title: overrides.title || `${sample.title} ${crypto.randomUUID().slice(0, 8)}`,
        media_type: 'artist',
        parent_id: null,
        custom_metadata: overrides.custom_metadata || {
            genres: sample.genres,
        },
    };
}

export function createTestAlbum(
    artistId: string,
    overrides: Partial<TestMusicAlbum> = {},
): TestMusicAlbum {
    const sample = SAMPLE_MUSIC_ALBUMS[Math.floor(Math.random() * SAMPLE_MUSIC_ALBUMS.length)];
    return {
        id: overrides.id || crypto.randomUUID(),
        // Unique default title so two albums under one artist in the same test
        // can't collide on uq_music_album_parent_title (migration 16.77.0).
        // Explicit `overrides.title` is still honored verbatim.
        title: overrides.title || `${sample.title} ${crypto.randomUUID().slice(0, 8)}`,
        media_type: 'album',
        parent_id: overrides.parent_id || artistId,
        year: overrides.year ?? sample.year,
        custom_metadata: overrides.custom_metadata || {
            genre: sample.genre,
            release_year: sample.year,
        },
    };
}

export function createTestTrack(
    albumId: string,
    trackNumber: number,
    overrides: Partial<TestMusicTrack> = {},
): TestMusicTrack {
    const sample = SAMPLE_MUSIC_TRACKS[(trackNumber - 1) % SAMPLE_MUSIC_TRACKS.length];
    return {
        id: overrides.id || crypto.randomUUID(),
        title: overrides.title || sample.title,
        media_type: 'track',
        parent_id: overrides.parent_id || albumId,
        sort_order: overrides.sort_order ?? trackNumber,
        runtime_seconds: overrides.runtime_seconds ?? sample.runtime,
        custom_metadata: overrides.custom_metadata || {
            artist: 'Test Artist',
            album: 'Test Album',
            track_number: trackNumber,
            essentia: {
                bpm: sample.bpm,
                key: sample.key,
                scale: sample.scale,
                energy: sample.energy,
                danceability: sample.danceability,
                beat_grid: [0, Math.round(60000 / sample.bpm)],
                downbeats: [0],
            },
        },
    };
}

// =============================================================================
// Insert Functions
// =============================================================================

export async function insertTestArtist(sql: Sql, artist: TestMusicArtist): Promise<string> {
    await sql`
        INSERT INTO media_items (id, title, media_type, parent_id, custom_metadata, created_at, updated_at)
        VALUES (
            ${artist.id}::uuid,
            ${artist.title},
            ${artist.media_type},
            NULL,
            ${sql.json(artist.custom_metadata as Record<string, never>)},
            NOW(), NOW()
        )
    `;
    return artist.id;
}

export async function insertTestAlbum(sql: Sql, album: TestMusicAlbum): Promise<string> {
    await sql`
        INSERT INTO media_items (id, title, media_type, parent_id, year, custom_metadata, created_at, updated_at)
        VALUES (
            ${album.id}::uuid,
            ${album.title},
            ${album.media_type},
            ${album.parent_id}::uuid,
            ${album.year},
            ${sql.json(album.custom_metadata as Record<string, never>)},
            NOW(), NOW()
        )
    `;
    return album.id;
}

export async function insertTestTrack(sql: Sql, track: TestMusicTrack): Promise<string> {
    await sql`
        INSERT INTO media_items (
            id, title, media_type, parent_id, sort_order,
            runtime_seconds, custom_metadata, created_at, updated_at
        )
        VALUES (
            ${track.id}::uuid,
            ${track.title},
            ${track.media_type},
            ${track.parent_id}::uuid,
            ${track.sort_order},
            ${track.runtime_seconds},
            ${sql.json(track.custom_metadata as Record<string, never>)},
            NOW(), NOW()
        )
    `;

    // Insert a media_files row with an audio extension so that getAlbums
    // (and related queries) which require an audio-file EXISTS check can find
    // this track.
    const fileId = crypto.randomUUID();
    await sql`
        INSERT INTO media_files (id, file_path, created_at, updated_at)
        VALUES (
            ${fileId}::uuid,
            ${`/test/music/${track.id}.mp3`},
            NOW(), NOW()
        )
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
        VALUES (
            ${fileId}::uuid,
            ${track.id}::uuid,
            true,
            0
        )
    `;

    // Mark the track as having files so queries with `has_files = true` can find it.
    await sql`
        UPDATE media_items SET has_files = true WHERE id = ${track.id}::uuid
    `;

    return track.id;
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Create and insert a full music hierarchy: artist → album → N tracks.
 * Optionally includes embeddings for similarity search tests.
 */
export async function createAndInsertTestMusicHierarchy(
    sql: Sql,
    options: {
        artistTitle?: string;
        albumTitle?: string;
        trackCount?: number;
        withEmbeddings?: boolean;
        genre?: string;
    } = {},
): Promise<{
    artistId: string;
    albumId: string;
    trackIds: string[];
}> {
    const trackCount = options.trackCount ?? 3;

    const artist = createTestArtist({
        title: options.artistTitle,
    });
    if (options.genre) {
        artist.custom_metadata = { genres: [options.genre] };
    }

    const album = createTestAlbum(artist.id, {
        title: options.albumTitle,
    });
    if (options.genre) {
        album.custom_metadata = {
            ...album.custom_metadata,
            genre: options.genre,
        };
    }

    await insertTestArtist(sql, artist);
    await insertTestAlbum(sql, album);

    const trackIds: string[] = [];
    for (let i = 1; i <= trackCount; i++) {
        // Nest the audio-feature fields under `essentia` (matching the default
        // `createTestTrack` shape) so consumers reading
        // `custom_metadata.essentia.bpm` see the values. Plain
        // `...SAMPLE_MUSIC_TRACKS[...]` spreads them flat, which broke
        // `getAlbumWithTracks` / `getTrackDetail` essentia assertions.
        const sample = SAMPLE_MUSIC_TRACKS[(i - 1) % SAMPLE_MUSIC_TRACKS.length];
        const track = createTestTrack(album.id, i, {
            custom_metadata: {
                artist: artist.title,
                album: album.title,
                track_number: i,
                essentia: {
                    bpm: sample.bpm,
                    key: sample.key,
                    scale: sample.scale,
                    energy: sample.energy,
                    danceability: sample.danceability,
                    beat_grid: [0, Math.round(60000 / sample.bpm)],
                    downbeats: [0],
                },
                ...(options.genre ? { genre: options.genre } : {}),
            },
        });
        await insertTestTrack(sql, track);
        trackIds.push(track.id);

        if (options.withEmbeddings) {
            // Use 'custom' source since 'music' is not in the original union type
            // The actual queries use source = 'music'
            const embedding = createTestEmbedding(track.id, 'custom', 1024);
            // Override source to 'music' via raw SQL
            const vectorString = `[${embedding.embedding.join(',')}]`;
            await sql`
                INSERT INTO media_embeddings (media_id, embedding, source)
                VALUES (${track.id}::uuid, ${vectorString}::vector, 'music')
            `;
        }
    }

    return { artistId: artist.id, albumId: album.id, trackIds };
}

// =============================================================================
// Index-safe identical embedding for ANN fixtures
// =============================================================================

/**
 * A fixed, NON-degenerate 1024-dim vector for music-embedding fixtures.
 *
 * Several suites used to seed `Array(1024).fill(0)` here, to express "all
 * candidates are equally close". That fixture is an impossible object: pgvector
 * defines cosine distance via the vector magnitudes, so `<=>` against an
 * all-zero vector is **NaN**, and `idx_me_music_hnsw`
 * (`hnsw (embedding vector_cosine_ops) WHERE source = 'music'`) cannot order
 * NaN — a `SELECT … ORDER BY embedding <=> $zero LIMIT 500` served by that
 * index returns ZERO of the matching rows (measured: 0/4 with the index scan,
 * 4/4 with the identical query on a non-zero vector).
 *
 * That made every ANN-backed music test order-dependent rather than wrong:
 * run alone, the freshly-truncated tiny table gets a Seq Scan and the rows come
 * back; run after other files have grown the table (so the planner's row
 * estimate favours the HNSW index), the plan flips to the index scan and the
 * query returns nothing — surfacing as "expected [] to include 'Different
 * Song'" and "expected undefined to be defined".
 *
 * This vector keeps the property the fixtures actually wanted — every seeded
 * row gets the SAME embedding, so all pairwise distances are exactly 0 and
 * ranking stays a pure tie — while having a defined magnitude, so both the Seq
 * Scan and the HNSW index return the rows.
 */
export const MUSIC_FIXTURE_EMBEDDING_DIMS = 1024;

export function musicFixtureEmbedding(dims: number = MUSIC_FIXTURE_EMBEDDING_DIMS): number[] {
    const v = new Array<number>(dims).fill(0);
    v[0] = 1;
    return v;
}

/** The same vector rendered as a pgvector literal, e.g. `[1,0,0,…]`. */
export function musicFixtureEmbeddingLiteral(dims: number = MUSIC_FIXTURE_EMBEDDING_DIMS): string {
    return `[${musicFixtureEmbedding(dims).join(',')}]`;
}
