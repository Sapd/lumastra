// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The same film in two libraries, scanned without a metadata provider, then
 * re-matched once a TMDB key is added.
 *
 * Found on a fresh public-image install (2026-10-14): "The Vanishing Lady" sat in
 * both /media/movies and /media/kids. Without a key both copies became versions
 * of ONE file-name item (title+year grouping). After the key was added, the
 * rescan moved the movies/ copy to the new TMDB item and detached it from the
 * file-name item, which took the item's default file away and left the kids
 * copy as a non-default link: the deferred `check_media_file_items_one_default`
 * trigger raised at commit, the detach rolled back, and the file-name item kept
 * its links. The title then showed twice in search and Browse.
 *
 * The model is one media item with two files (versions), as on a first scan
 * with a provider. Since the in-place re-identification fix the file-name item
 * itself takes the TMDB id: both copies stay on it, nothing is dismissed, and
 * the scanner logs no error. (A match whose id another item already holds still
 * moves the copies there; detachAndClearAwaitingMatchForFile keeps that path
 * trigger-safe.)
 *
 * Real scanner, real Postgres, real files and real ffprobe; only the metadata
 * provider (and the fire-and-forget lifecycle enqueue) is stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import { getMediaAlphabetical } from '../../../../../../database/queries/browse.queries.js';
import { unrestrictedAccess } from '../../../../../../database/queries/builders/media-access-boundary.js';
import type { FileScannerContext } from './shared.js';

const provider = vi.hoisted(() => ({
    configured: false,
    match: null as null | {
        externalId: string;
        provider: string;
        title: string;
        year?: number;
        mediaType: string;
        confidence: number;
    },
}));

vi.mock('../../../../../plugin-context.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isProviderConfigured: vi.fn(async () => provider.configured),
}));
vi.mock('../../../../../../services/metadata-matching.service.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    matchFileToMetadata: vi.fn(async () =>
        provider.match ? { matched: true, candidate: provider.match } : { matched: false },
    ),
}));
vi.mock('../../../../../../services/media-lifecycle.service.js', async (importOriginal) => {
    const actual = await importOriginal<{ MediaLifecycleService: object }>();
    return {
        ...actual,
        MediaLifecycleService: Object.assign(Object.create(actual.MediaLifecycleService), {
            afterMatched: vi.fn(async () => undefined),
        }),
    };
});

const { processVideoFile } = await import('./video-processor.js');

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');
const TMDB = 'tmdb-metadata-provider';
const FOLDER = 'The Vanishing Lady (1896)';

describe('same film in two libraries, re-matched after a provider key is added (real PG)', () => {
    let sql: postgres.Sql;
    let root: string;
    let movies: LibraryPathRow;
    let kids: LibraryPathRow;
    let errors: unknown[][];
    let warns: unknown[][];
    let context: FileScannerContext;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        provider.configured = false;
        provider.match = null;
        errors = [];
        warns = [];
        const logger = {
            info: (): void => undefined,
            debug: (): void => undefined,
            warn: (...args: unknown[]): void => void warns.push(args),
            error: (...args: unknown[]): void => void errors.push(args),
        };
        context = { sql, logger } as unknown as FileScannerContext;
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-cross-library-'));

        const created: Array<{ lp: string; group: string }> = [];
        const library = async (name: string): Promise<LibraryPathRow> => {
            await mkdir(join(root, name), { recursive: true });
            const [group] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name) VALUES (${`${name}-${Date.now()}`})
                RETURNING id
            `;
            const [lp] = await sql<LibraryPathRow[]>`
                INSERT INTO library_paths (path, media_type, library_group_id, enabled, provider)
                VALUES (${join(root, name)}, 'movie', ${group.id}, true, 'tmdb')
                RETURNING *
            `;
            created.push({ lp: lp.id, group: group.id });
            return lp;
        };
        movies = await library('movies');
        kids = await library('kids');

        return async () => {
            await rm(root, { recursive: true, force: true });
            for (const { lp, group } of created) {
                await sql`DELETE FROM library_paths WHERE id = ${lp}`;
                await sql`DELETE FROM library_groups WHERE id = ${group}`;
            }
        };
    });

    async function copyIn(lib: LibraryPathRow): Promise<string> {
        const dir = join(lib.path, FOLDER);
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, `${FOLDER}.mp4`);
        await copyFile(FIXTURE, filePath);
        return filePath;
    }

    const scan = (filePath: string, lib: LibraryPathRow): Promise<unknown> =>
        processVideoFile(sql, filePath, lib, [TMDB], context);

    async function linkedItems(filePath: string): Promise<string[]> {
        const rows = await sql<{ media_item_id: string }[]>`
            SELECT mfi.media_item_id
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE mf.file_path = ${filePath}
            ORDER BY mfi.media_item_id
        `;
        return rows.map((r) => r.media_item_id);
    }

    /** Movies a user can see: what search and Browse list. */
    async function visibleMovies(): Promise<string[]> {
        const rows = await sql<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE media_type = 'movie' AND has_files = true AND NOT is_dismissed
            ORDER BY id
        `;
        return rows.map((r) => r.id);
    }

    async function defaultsPerItem(): Promise<
        Array<{ id: string; files: number; defaults: number }>
    > {
        return sql<Array<{ id: string; files: number; defaults: number }>>`
            SELECT media_item_id AS id, count(*)::int AS files,
                   count(*) FILTER (WHERE is_default)::int AS defaults
            FROM media_file_items GROUP BY media_item_id ORDER BY media_item_id
        `;
    }

    async function setUpUnmatched(): Promise<{ m: string; k: string; personalId: string }> {
        const m = await copyIn(movies);
        const k = await copyIn(kids);
        await scan(m, movies);
        await scan(k, kids);
        // Without a provider both copies are versions of one file-name item.
        const [personalId] = await linkedItems(m);
        expect(await linkedItems(k)).toEqual([personalId]);
        expect(await visibleMovies()).toEqual([personalId]);

        provider.configured = true;
        provider.match = {
            externalId: '135',
            provider: 'tmdb',
            title: 'The Vanishing Lady',
            year: 1896,
            mediaType: 'movie',
            confidence: 0.95,
        };
        return { m, k, personalId };
    }

    async function expectOneMatchedItem(m: string, k: string, personalId: string): Promise<void> {
        // Identified in place: the file-name item is the matched item.
        const [matchedId] = await linkedItems(m);
        expect(matchedId).toBe(personalId);
        expect(await linkedItems(k)).toEqual([matchedId]);
        expect(await visibleMovies()).toEqual([matchedId]);
        expect(await defaultsPerItem()).toEqual([{ id: matchedId, files: 2, defaults: 1 }]);

        const [item] = await sql<
            { is_dismissed: boolean; has_files: boolean; awaiting: boolean | null; tmdb: string }[]
        >`
            SELECT is_dismissed, has_files,
                   (custom_metadata->>'awaiting_provider_match')::boolean AS awaiting,
                   (SELECT external_id FROM external_ids
                    WHERE media_id = mi.id AND provider = 'tmdb') AS tmdb
            FROM media_items mi WHERE id = ${personalId}::uuid
        `;
        expect(item).toEqual({ is_dismissed: false, has_files: true, awaiting: null, tmdb: '135' });

        const browse = await getMediaAlphabetical(sql, {
            mediaType: 'movie',
            access: unrestrictedAccess(),
        });
        expect(browse.totalCount).toBe(1);
        expect(browse.items).toHaveLength(1);

        expect(errors).toEqual([]);
        expect(JSON.stringify(warns)).not.toMatch(/one_default|invariant violated/);
    }

    it('movies/ copy re-matched first: both copies land on the matched item, no trigger error', async () => {
        const { m, k, personalId } = await setUpUnmatched();

        await scan(m, movies);
        // The kids copy never left the item that was just identified.
        expect(await linkedItems(k)).toEqual([personalId]);
        await scan(k, kids);

        await expectOneMatchedItem(m, k, personalId);
    });

    it('kids/ copy re-matched first: same result', async () => {
        const { m, k, personalId } = await setUpUnmatched();

        await scan(k, kids);
        await scan(m, movies);

        await expectOneMatchedItem(m, k, personalId);
    });

    it('the next scan leaves the result alone', async () => {
        const { m, k, personalId } = await setUpUnmatched();
        await scan(m, movies);
        await scan(k, kids);
        await scan(m, movies);
        await scan(k, kids);

        await expectOneMatchedItem(m, k, personalId);
    });
});
