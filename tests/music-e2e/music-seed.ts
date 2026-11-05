// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fixtures + seeding for the music player e2e (tests/playwright/playwright.music.config.ts).
 *
 * The audio is GENERATED here with ffmpeg (pure sine tones, tagged): no third-party
 * recordings, nothing binary in the repo. Every crossfade track has its OWN tone, so
 * the in-page analyser (music-harness.ts) can tell which track is audible from the
 * spectrum alone — that is how "the old track keeps playing" and "the incoming track
 * starts at the fade point" are measured, rather than inferred from player state.
 *
 * Rows get fresh ids every run (the catalog is written to catalog.json for the spec
 * workers); globalSetup deletes the previous run's rows by title prefix first, so no
 * play history or queue memory of an earlier run can steer this one.
 */

import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import postgres from 'postgres';
import { fixtureDir, outDir } from './music-env';

/** Every seeded title starts with this, so globalSetup can find leftovers. */
export const PREFIX = 'ME2E';

export const LIBRARY_GROUP_ID = '7e2e0000-0000-4000-8000-00000e2e0a10';
export const LIBRARY_PATH_ID = '7e2e0000-0000-4000-8000-00000e2e0a11';

const SHARED_DATABASES = new Set(['lumastra', 'lumastra_dev']);

export function connect(): postgres.Sql {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required for the music e2e');
    const db = new URL(url).pathname.replace(/^\//, '');
    if (SHARED_DATABASES.has(db)) {
        throw new Error(`refusing to run the music e2e against shared database '${db}'`);
    }
    return postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
}

// ---------------------------------------------------------------------------
// Catalog shape (what the spec reads back from catalog.json)
// ---------------------------------------------------------------------------

export interface SeedTrack {
    id: string;
    title: string;
    /** Tone in Hz: the analyser identifies the track by it. */
    hz: number;
    seconds: number;
    albumId: string;
    artistId: string;
    file: string;
}

export interface Catalog {
    artists: Record<'tone' | 'search' | 'radio', { id: string; name: string }>;
    albums: Record<'xfade' | 'long' | 'search' | 'radio' | 'range', { id: string; title: string }>;
    /** 4 × 90 s, 120 BPM analysis, outro at 75 s. XF3 carries a dj-outro boundary. */
    xfade: SeedTrack[];
    /** 3 × 150 s, no analysis — mirroring scenarios, long enough to never end. */
    long: SeedTrack[];
    /** "Zephyr …" songs for the fast-search scenario. */
    search: SeedTrack[];
    radio: { seed: SeedTrack; chill: SeedTrack[]; workout: SeedTrack[] };
    /** A FLAC the v1 transcode path re-encodes (Range reconnect). */
    flac: SeedTrack;
    clusters: { chill: number; workout: number };
}

export const XF = {
    bpm: 120,
    // Longer than the mini-player's 45 s Up Next lead, so the info strip really
    // hides after a fade (the incoming track's own fade is further away).
    seconds: 90,
    outroStartMs: 75_000,
    introEndMs: 2_000,
    /** playback-preferences musicCrossfadeBeats: 16 beats at 120 BPM = 8 s. */
    beats: 16,
    fadeMs: 8_000,
} as const;

export function readCatalog(): Catalog {
    return JSON.parse(readFileSync(join(outDir(), 'catalog.json'), 'utf8')) as Catalog;
}

// ---------------------------------------------------------------------------
// Audio generation
// ---------------------------------------------------------------------------

function ffmpegBin(): string {
    return process.env.FFMPEG_PATH || 'ffmpeg';
}

/** A tagged sine tone. Cached by name: the content depends only on the arguments. */
function tone(
    dir: string,
    name: string,
    hz: number,
    seconds: number,
    tags: { title: string; artist: string; album: string },
    codec: 'mp3' | 'flac' = 'mp3',
): string {
    // The name carries everything the content depends on, so a fixture directory
    // left over from a run with other parameters can never serve a stale file.
    const file = resolve(dir, `${name}-${hz}hz-${seconds}s.${codec}`);
    if (existsSync(file)) return file;
    const enc =
        codec === 'mp3'
            ? ['-c:a', 'libmp3lame', '-b:a', '96k']
            : ['-c:a', 'flac', '-sample_fmt', 's16'];
    execFileSync(
        ffmpegBin(),
        [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'lavfi',
            '-i',
            `sine=frequency=${hz}:sample_rate=44100:duration=${seconds}`,
            '-af',
            'volume=0.5',
            '-ac',
            '2',
            '-metadata',
            `title=${tags.title}`,
            '-metadata',
            `artist=${tags.artist}`,
            '-metadata',
            `album=${tags.album}`,
            ...enc,
            file,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    return file;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function insertItem(
    sql: postgres.Sql,
    row: {
        id: string;
        title: string;
        type: 'artist' | 'album' | 'track';
        parentId?: string;
        file?: string;
        sortOrder?: number;
        seconds?: number;
        meta: Record<string, unknown>;
    },
): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, parent_id, file_path, sort_order,
                                 runtime_seconds, has_files, status, created_at, updated_at, custom_metadata)
        VALUES (${row.id}, ${row.title}, ${row.type}, ${row.parentId ?? null}, ${row.file ?? null},
                ${row.sortOrder ?? null}, ${row.seconds ?? null}, true, 'active', NOW(), NOW(),
                ${sql.json(row.meta as never)})
    `;
    if (!row.file) return;
    const files = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path, library_group_id, duration_seconds)
        VALUES (${row.file}, ${LIBRARY_GROUP_ID}, ${row.seconds ?? null})
        ON CONFLICT (file_path) DO UPDATE SET library_group_id = EXCLUDED.library_group_id,
                                              is_missing = false, updated_at = NOW()
        RETURNING id
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id)
        VALUES (${files[0].id}, ${row.id})
        ON CONFLICT DO NOTHING
    `;
}

/** 120 BPM analysis for an `seconds`-long track (beat grid + downbeats in SECONDS). */
function essentia120(
    seconds: number,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    const beats: number[] = [];
    for (let t = 0; t < seconds; t += 0.5) beats.push(t);
    return {
        bpm: XF.bpm,
        key: 'C',
        scale: 'major',
        energy: 0.7,
        danceability: 0.7,
        loudness_lufs: -14,
        beat_grid: beats,
        downbeats: beats.filter((_, i) => i % 4 === 0),
        intro_end_ms: XF.introEndMs,
        outro_start_ms: XF.outroStartMs,
        outro_source: 'downbeat',
        vocal_instrumental: 'instrumental',
        ...extra,
    };
}

/** A 1024-d unit vector mostly along `axes` (weights), deterministic. */
function vec(weights: Record<number, number>, jitterSeed = 0): string {
    const v = new Array<number>(1024).fill(0);
    for (const [axis, w] of Object.entries(weights)) v[Number(axis)] = w;
    // A little per-track spread on unrelated axes, so no two tracks tie exactly.
    if (jitterSeed) v[100 + jitterSeed] = 0.05;
    const n = Math.hypot(...v);
    return `[${v.map((x) => (x / n).toFixed(6)).join(',')}]`;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export async function cleanupOldRows(sql: postgres.Sql): Promise<void> {
    const ids = sql`SELECT id FROM media_items WHERE title LIKE ${PREFIX + '%'}`;
    for (const s of [
        sql`DELETE FROM media_audio_clusters WHERE media_id IN (${ids})`,
        sql`DELETE FROM media_audio_embeddings WHERE media_id IN (${ids})`,
        sql`DELETE FROM media_embeddings WHERE media_id IN (${ids})`,
        sql`DELETE FROM user_music_state WHERE track_id IN (${ids})`,
        sql`DELETE FROM media_file_items WHERE media_item_id IN (${ids})`,
        sql`DELETE FROM mood_vectors WHERE mood_key = 'music:chill' AND description = ${PREFIX}`,
    ]) {
        await s.catch(() => {});
    }
    for (const type of ['track', 'album', 'artist']) {
        await sql`DELETE FROM media_items WHERE media_type = ${type} AND id IN (${ids})`.catch(
            () => {},
        );
    }
}

export async function seedCatalog(sql: postgres.Sql): Promise<Catalog> {
    const dir = resolve(fixtureDir());
    mkdirSync(dir, { recursive: true });

    await sql`
        INSERT INTO library_groups (id, name, description)
        VALUES (${LIBRARY_GROUP_ID}, 'Music E2E', 'Music player e2e fixtures')
        ON CONFLICT (id) DO NOTHING
    `;
    await sql`
        INSERT INTO library_paths (id, path, media_type, provider, library_group_id, enabled)
        VALUES (${LIBRARY_PATH_ID}, ${dir}, 'music', 'musicbrainz', ${LIBRARY_GROUP_ID}, true)
        ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path, enabled = true
    `;

    const artists = {
        tone: { id: randomUUID(), name: `${PREFIX} Tone Artist` },
        search: { id: randomUUID(), name: `${PREFIX} Zephyr Ensemble` },
        radio: { id: randomUUID(), name: `${PREFIX} Radio Artist` },
    };
    const albums = {
        xfade: { id: randomUUID(), title: `${PREFIX} Crossfade Album` },
        long: { id: randomUUID(), title: `${PREFIX} Long Album` },
        search: { id: randomUUID(), title: `${PREFIX} Zephyr Album` },
        radio: { id: randomUUID(), title: `${PREFIX} Radio Album` },
        range: { id: randomUUID(), title: `${PREFIX} Range Album` },
    };
    const albumArtist = {
        xfade: 'tone',
        long: 'tone',
        search: 'search',
        radio: 'radio',
        range: 'tone',
    } as const;

    for (const a of Object.values(artists)) {
        await insertItem(sql, {
            id: a.id,
            title: a.name,
            type: 'artist',
            meta: { genres: ['Electronic'] },
        });
    }
    for (const [key, al] of Object.entries(albums) as [
        keyof typeof albums,
        { id: string; title: string },
    ][]) {
        await insertItem(sql, {
            id: al.id,
            title: al.title,
            type: 'album',
            parentId: artists[albumArtist[key]].id,
            meta: {
                genres: ['Electronic'],
                release_year: 2026,
                artist: artists[albumArtist[key]].name,
            },
        });
    }

    async function track(
        album: keyof typeof albums,
        n: number,
        title: string,
        hz: number,
        seconds: number,
        file: string,
        essentia?: Record<string, unknown>,
    ): Promise<SeedTrack> {
        const id = randomUUID();
        const artist = artists[albumArtist[album]];
        await insertItem(sql, {
            id,
            title,
            type: 'track',
            parentId: albums[album].id,
            file,
            sortOrder: n,
            seconds,
            meta: {
                artist: artist.name,
                album: albums[album].title,
                track_number: n,
                genres: ['Electronic'],
                release_year: 2026,
                ...(essentia ? { essentia } : {}),
            },
        });
        return { id, title, hz, seconds, albumId: albums[album].id, artistId: artist.id, file };
    }

    const tagsFor = (album: keyof typeof albums, title: string) => ({
        title,
        artist: artists[albumArtist[album]].name,
        album: albums[album].title,
    });

    // Crossfade album: distinct tones, 120 BPM analysis, outro at 30 s.
    const xfade: SeedTrack[] = [];
    const xfHz = [440, 660, 880, 1100];
    for (let i = 0; i < 4; i++) {
        const title = `${PREFIX} Tone ${i + 1}`;
        const file = tone(dir, `xf-${i + 1}`, xfHz[i], XF.seconds, tagsFor('xfade', title));
        // XF3: a dj-outro boundary whose vocals "end" after it. The client must not
        // push the fade to the vocal end (the server already placed the boundary
        // after the vocals) — crossfade-plan.ts guardLastVocalEndMs.
        const extra =
            i === 2
                ? {
                      outro_source: 'dj-outro',
                      vocal_instrumental: 'voice',
                      last_vocal_end_ms: 79_000,
                  }
                : {};
        xfade.push(
            await track(
                'xfade',
                i + 1,
                title,
                xfHz[i],
                XF.seconds,
                file,
                essentia120(XF.seconds, extra),
            ),
        );
    }

    // Long album: no analysis (never crossfades mid-scenario), 150 s each.
    const long: SeedTrack[] = [];
    const longHz = [300, 500, 700];
    for (let i = 0; i < 3; i++) {
        const title = `${PREFIX} Long ${i + 1}`;
        const file = tone(dir, `long-${i + 1}`, longHz[i], 150, tagsFor('long', title));
        long.push(await track('long', i + 1, title, longHz[i], 150, file));
    }

    // Search album: one shared 30 s file.
    const searchFile = tone(dir, 'search', 1300, 30, tagsFor('search', `${PREFIX} Zephyr`));
    const search: SeedTrack[] = [];
    for (const [i, word] of ['Alpha', 'Beta', 'Gamma'].entries()) {
        search.push(await track('search', i + 1, `${PREFIX} Zephyr ${word}`, 1300, 30, searchFile));
    }

    // Radio: 120 s (autoplay skips tracks under MUSIC_AUTOPLAY_MIN_TRACK_SECONDS = 90),
    // one shared file, analysis so the queue's audio-feature scoring has data.
    const RADIO_S = 120;
    const radioFile = tone(dir, 'radio', 600, RADIO_S, tagsFor('radio', `${PREFIX} Radio`));
    const radioEss = (energy: number) => ({
        ...essentia120(RADIO_S),
        energy,
        outro_start_ms: 105_000,
    });
    const radioSeed = await track(
        'radio',
        1,
        `${PREFIX} Radio Seed`,
        600,
        RADIO_S,
        radioFile,
        radioEss(0.4),
    );
    const chill: SeedTrack[] = [];
    const workout: SeedTrack[] = [];
    for (let i = 0; i < 5; i++) {
        chill.push(
            await track(
                'radio',
                10 + i,
                `${PREFIX} Chill ${i + 1}`,
                600,
                RADIO_S,
                radioFile,
                radioEss(0.4),
            ),
        );
        workout.push(
            await track(
                'radio',
                20 + i,
                `${PREFIX} Workout ${i + 1}`,
                600,
                RADIO_S,
                radioFile,
                radioEss(0.4),
            ),
        );
    }

    // FLAC for the v1 transcode path.
    const flacFile = tone(dir, 'range', 750, 60, tagsFor('range', `${PREFIX} Range`), 'flac');
    const flac = await track('range', 1, `${PREFIX} Range FLAC`, 750, 60, flacFile);

    // Sonic space (MSCLAP, 1024-d). Axis 0 = the seed's sound, axis 1 = "chill".
    // Workout tracks sit right next to the seed; chill tracks lean toward the mood.
    // Without the mood arm the queue follows the seed (workout); with it, chill wins
    // (blend 0.4·seed + 0.35·mood, sonic-queue.queries.ts buildBlendedVector).
    const MODEL = 'msclap-2023';
    const sonic = async (t: SeedTrack, v: string): Promise<void> => {
        await sql`
            INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
            VALUES (${t.id}, ${MODEL}, ${v}::vector)
        `;
    };
    await sonic(radioSeed, vec({ 0: 1 }));
    for (const [i, t] of chill.entries()) await sonic(t, vec({ 0: 0.6, 1: 0.8 }, i + 1));
    for (const [i, t] of workout.entries()) await sonic(t, vec({ 0: 0.97, 2: 0.24 }, i + 10));
    await sql`DELETE FROM mood_vectors WHERE mood_key = 'music:chill'`;
    await sql`
        INSERT INTO mood_vectors (mood_key, display_name, description, vector, model_id, seed_media_ids, seed_count)
        VALUES ('music:chill', 'Chill', ${PREFIX}, ${vec({ 1: 1 })}::vector, ${MODEL},
                ${chill.map((t) => t.id)}::uuid[], ${chill.length})
    `;
    // Bootstrap (queue/bootstrap?mood=chill) picks among tracks with a TEXT embedding
    // (media_embeddings source='music'): give only the seed one, so it is the start.
    await sql`
        INSERT INTO media_embeddings (media_id, source, embedding)
        VALUES (${radioSeed.id}, 'music', ${vec({ 0: 1 })}::vector)
    `;
    // Fresh ids every run: the web's cluster member list is cached server-side.
    const base = 10_000 + Math.floor(Math.random() * 80_000) * 2;
    const clusters = { chill: base, workout: base + 1 };
    for (const t of chill) {
        await sql`INSERT INTO media_audio_clusters (media_id, model_id, cluster_id) VALUES (${t.id}, ${MODEL}, ${clusters.chill})`;
    }
    for (const t of workout) {
        await sql`INSERT INTO media_audio_clusters (media_id, model_id, cluster_id) VALUES (${t.id}, ${MODEL}, ${clusters.workout})`;
    }
    for (const c of Object.values(clusters)) {
        await sql`INSERT INTO audio_cluster_ids (model_id, cluster_id) VALUES (${MODEL}, ${c}) ON CONFLICT DO NOTHING`.catch(
            () => {},
        );
    }

    const catalog: Catalog = {
        artists,
        albums,
        xfade,
        long,
        search,
        radio: { seed: radioSeed, chill, workout },
        flac,
        clusters,
    };
    mkdirSync(outDir(), { recursive: true });
    writeFileSync(join(outDir(), 'catalog.json'), JSON.stringify(catalog, null, 2));
    return catalog;
}
