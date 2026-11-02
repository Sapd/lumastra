// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seeding for the web-only Watch Together e2e (playwright.watch-together.config.ts).
 *
 * Every scenario seeds its OWN media rows with fresh RFC-4122 v4 ids, so no watch
 * progress, resume point or "already watched" flag from an earlier scenario (or an
 * earlier run) can steer the next one — a finished episode reopens at its end and
 * auto-advances, which once made an episode scenario test the wrong thing.
 *
 * The files are served only from inside an ENABLED library root (fail-closed
 * containment in media-path-resolver.ts), so globalSetup registers a root that holds
 * nothing but these fixtures.
 */

import { randomUUID } from 'crypto';
import { copyFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = resolve(HERE, '../fixtures/watch-together');
/** 240 s, H.264 High 640x360 24 fps + AAC (see tests/fixtures/README.md). */
export const MOVIE_FILE = resolve(FIXTURE_DIR, 'wt-movie-240s.mp4');
export const MOVIE_SECONDS = 240;
/** 60 s cut of the same encode, used for every episode. */
export const EPISODE_FILE = resolve(FIXTURE_DIR, 'wt-episode-60s.mp4');
export const EPISODE_SECONDS = 60;

/** Fixed ids for the library root (all-hex, v4-shaped). */
export const LIBRARY_GROUP_ID = '7e2e0000-0000-4000-8000-0000000eb0a0';
export const LIBRARY_PATH_ID = '7e2e0000-0000-4000-8000-0000000eb0a1';

/** Every seeded title starts with this, so globalSetup can find leftovers. */
export const TITLE_PREFIX = 'WT Web E2E';

export const INTRO = { start: 5, end: 15 };
export const OUTRO = { start: 45, end: 60 };

/** Databases other people use; the e2e needs a dedicated one (CI service, runner slot). */
const SHARED_DATABASES = new Set(['lumastra', 'lumastra_dev']);

export function connect(): postgres.Sql {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required for the Watch Together e2e');
    // The setup ends the parties of test2/uitest and deletes rows it seeded; never let
    // it near a shared database (dev, preprod, prod).
    const db = new URL(url).pathname.replace(/^\//, '');
    if (SHARED_DATABASES.has(db)) {
        throw new Error(`refusing to run the Watch Together e2e against shared database '${db}'`);
    }
    return postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
}

async function linkFile(sql: postgres.Sql, mediaId: string, file: string): Promise<void> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path) VALUES (${file})
        ON CONFLICT (file_path) DO UPDATE SET updated_at = NOW()
        RETURNING id
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id)
        VALUES (${rows[0].id}, ${mediaId})
        ON CONFLICT DO NOTHING
    `;
}

export interface SeededMovie {
    id: string;
    title: string;
}

/** A playable movie backed by the 240 s fixture, under a fresh id. */
export async function seedMovie(sql: postgres.Sql, label: string): Promise<SeededMovie> {
    const id = randomUUID();
    const title = `${TITLE_PREFIX} ${label}`.slice(0, 200);
    await sql`
        INSERT INTO media_items (id, title, media_type, file_path, has_files, status, runtime_seconds, created_at, updated_at)
        VALUES (${id}, ${title}, 'movie', ${MOVIE_FILE}, true, 'active', ${MOVIE_SECONDS}, NOW(), NOW())
    `;
    await linkFile(sql, id, MOVIE_FILE);
    return { id, title };
}

export interface SeededShow {
    showId: string;
    seasonId: string;
    fixtureDir: string;
    /** Episodes 1..3 of season 1 (index 0 = episode 1). */
    episodes: { id: string; title: string }[];
}

/**
 * tv → season → 3 episodes, 60 s each, Intro 5–15 s and Outro 45–60 s (segment types
 * are capitalised: the column has a CHECK). Scenarios start on episode 2 — an
 * episode 1's intro can be suppressed by the player.
 */
export async function seedShow(sql: postgres.Sql, label: string): Promise<SeededShow> {
    const showId = randomUUID();
    const seasonId = randomUUID();
    const fixtureDir = resolve(FIXTURE_DIR, `wt-show-${showId}`);
    await mkdir(fixtureDir, { recursive: true });
    await sql`
        INSERT INTO media_items (id, title, media_type, has_files, status, created_at, updated_at)
        VALUES (${showId}, ${`${TITLE_PREFIX} Show ${label}`.slice(0, 200)}, 'tv', false, 'active', NOW(), NOW())
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, parent_id, season_number, has_files, status, created_at, updated_at)
        VALUES (${seasonId}, 'Season 1', 'season', ${showId}, 1, false, 'active', NOW(), NOW())
    `;
    const episodes: { id: string; title: string }[] = [];
    for (let n = 1; n <= 3; n++) {
        const id = randomUUID();
        const title = `${TITLE_PREFIX} Pattern Part ${n}`;
        // Distinct physical files model separate episodes. Linking all three to
        // EPISODE_FILE models one combined E01-E03 file, which correctly has no
        // next episode after playback.
        const episodeFile = resolve(fixtureDir, `episode-${n}.mp4`);
        await copyFile(EPISODE_FILE, episodeFile);
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number,
                                     file_path, has_files, status, runtime_seconds, created_at, updated_at)
            VALUES (${id}, ${title}, 'episode', ${seasonId}, 1, ${n},
                    ${episodeFile}, true, 'active', ${EPISODE_SECONDS}, NOW(), NOW())
        `;
        await linkFile(sql, id, episodeFile);
        await sql`
            INSERT INTO media_segments (media_id, type, start_time, end_time, source)
            VALUES (${id}, 'Intro', ${INTRO.start}, ${INTRO.end}, 'wt-web-e2e'),
                   (${id}, 'Outro', ${OUTRO.start}, ${OUTRO.end}, 'wt-web-e2e')
        `;
        episodes.push({ id, title });
    }
    return { showId, seasonId, fixtureDir, episodes };
}

/**
 * Remove what earlier runs seeded. Best effort, child rows first; each statement is
 * independent so a schema difference in one table cannot block the rest.
 */
export async function cleanupOldRows(sql: postgres.Sql): Promise<void> {
    const ids = sql`SELECT id FROM media_items WHERE title LIKE ${TITLE_PREFIX + '%'} OR title = 'Season 1' AND parent_id IN (SELECT id FROM media_items WHERE title LIKE ${TITLE_PREFIX + '%'})`;
    const statements = [
        sql`DELETE FROM user_media_state WHERE media_id IN (${ids})`,
        sql`DELETE FROM watch_history WHERE media_id IN (${ids})`,
        sql`DELETE FROM media_segments WHERE media_id IN (${ids})`,
        sql`DELETE FROM media_file_items WHERE media_item_id IN (${ids})`,
    ];
    for (const s of statements) await s.catch(() => {});
    // Episodes, then seasons, then shows/movies (parent_id FKs).
    for (const type of ['episode', 'season', 'tv', 'movie']) {
        await sql`
            DELETE FROM media_items
            WHERE media_type = ${type} AND id IN (${ids})
        `.catch(() => {});
    }
}
