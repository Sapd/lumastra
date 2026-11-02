// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The five music post-passes (unknown-artist rematch, collaboration/VA/
 * oversized-compilation merges, remixer links) work on the
 * whole music catalogue. They ran after EVERY per-library scan, so the hourly
 * movie and series scans each repeated them; on preprod a no-change series
 * scan spent ~40 s of its 43 s there (3 s for its own 4,010 files). They now
 * run only after a scan that covered a music library.
 *
 * Observed through the unknown-artist rematch: a track filed under "Unknown
 * Artist" whose folder names its artist is re-parented by that pass.
 * Real scanner, real Postgres; only the Valkey progress store is stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';

vi.mock('./progress-store.js', () => ({
    setScanProgress: async () => {},
    getScanProgress: async () => null,
    deleteScanProgress: async () => {},
    getAnyScanProgress: async () => null,
    getAggregateScanProgress: async () => null,
    getScanProgressByKey: async () => new Map(),
}));

import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import { scanForSync } from '../../file-scanner.js';

describe('file scanner — music post-passes run only for music libraries', () => {
    let sql: postgres.Sql;
    let movieRoot: string;
    let musicRoot: string;
    let moviePathId: string;
    let musicPathId: string;
    let trackId: string;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_paths`;
        await sql`DELETE FROM library_groups WHERE name LIKE 'postpass-gating-%'`;
        movieRoot = mkdtempSync(join(tmpdir(), 'postpass-movies-'));
        musicRoot = mkdtempSync(join(tmpdir(), 'postpass-music-'));
        mkdirSync(join(musicRoot, 'Folder Named Artist', 'Some Album'), { recursive: true });

        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`postpass-gating-${Date.now()}`}) RETURNING id`;
        const [mv] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${movieRoot}, 'movie', ${group.id}, true) RETURNING id`;
        const [mu] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${musicRoot}, 'music', ${group.id}, true) RETURNING id`;
        moviePathId = mv.id;
        musicPathId = mu.id;

        // Unknown Artist → album → track whose file (not on disk: tags cannot
        // be read, so the folder decides) sits under "Folder Named Artist".
        const [unknown] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status)
            VALUES ('artist', 'Unknown Artist', 'active') RETURNING id`;
        const [album] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, parent_id)
            VALUES ('album', 'Some Album', 'active', ${unknown.id}) RETURNING id`;
        const [track] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, parent_id, has_files)
            VALUES ('track', 'Song', 'active', ${album.id}, true) RETURNING id`;
        trackId = track.id;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path)
            VALUES (${join(musicRoot, 'Folder Named Artist', 'Some Album', '01 Song.mp3')})
            RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                  VALUES (${track.id}, ${file.id}, true)`;
    });
    afterEach(() => {
        rmSync(movieRoot, { recursive: true, force: true });
        rmSync(musicRoot, { recursive: true, force: true });
    });

    async function trackArtist(): Promise<string | null> {
        const [row] = await sql<{ title: string | null }[]>`
            SELECT artist.title
            FROM media_items track
            JOIN media_items album ON album.id = track.parent_id
            JOIN media_items artist ON artist.id = album.parent_id
            WHERE track.id = ${trackId}`;
        return row?.title ?? null;
    }

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    it('a movie-library scan leaves the music catalogue alone', async () => {
        await scanForSync(moviePathId, { sql, logger } as never);
        expect(await trackArtist()).toBe('Unknown Artist');
    });

    it('a music-library scan still runs them', async () => {
        await scanForSync(musicPathId, { sql, logger } as never);
        expect(await trackArtist()).toBe('Folder Named Artist');
    });
});
