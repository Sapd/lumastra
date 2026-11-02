// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The absolute episode number in a file name (`S09E21 - 188 - Title`) reaches
 * media_files.absolute_episode through the real scanner. Real PostgreSQL and
 * ffprobe; only provider search and lifecycle enqueue are stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import {
    closeTestDb,
    getTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    TEST_TABLES,
    truncateTables,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import { loadMediaFilesByPrefix } from '../../../../../../database/queries/media-files.queries.js';
import { hashFileHead } from '../../../../../../utils/file-hash.js';
import type { MetadataCandidate } from '../../../../../../providers/types.js';
import type { FileScannerContext } from './shared.js';
import { Logger } from '../../../../../../utils/logger.js';

const provider = vi.hoisted(() => ({
    candidates: new Map<string, MetadataCandidate>(),
    afterMatched: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    afterReclaimed: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));
// Observable round-trips of the per-file absolute_episode write.
const writes = vi.hoisted(() => ({
    setAbsolute: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('../../../../../../database/queries/media-files.queries.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('../../../../../../database/queries/media-files.queries.js')
        >();
    writes.setAbsolute = vi.fn(actual.setAbsoluteEpisodeIfChanged);
    return { ...actual, setAbsoluteEpisodeIfChanged: writes.setAbsolute };
});

vi.mock('../../../../../plugin-context.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isProviderConfigured: vi.fn(async () => true),
}));
vi.mock('../../../../../../services/metadata-matching.service.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    matchFileToMetadata: vi.fn(async (filePath: string) => {
        const candidate = provider.candidates.get(filePath);
        if (!candidate) throw new Error(`Missing provider fixture: ${filePath}`);
        return { matched: true, candidate };
    }),
}));
vi.mock('../../../../../../services/media-lifecycle.service.js', async (importOriginal) => {
    const actual = await importOriginal<{ MediaLifecycleService: object }>();
    return {
        ...actual,
        MediaLifecycleService: Object.assign(Object.create(actual.MediaLifecycleService), {
            afterMatched: provider.afterMatched,
            afterReclaimed: provider.afterReclaimed,
        }),
    };
});

const { processVideoFile } = await import('./video-processor.js');

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');
const TMDB = 'tmdb-metadata-provider';
const TITLE = 'Bleach';
const SHOW_TMDB = '930002';

describe('daily-show air dates (real PG, scanner and ffprobe)', () => {
    let sql: postgres.Sql;
    let root: string;
    let libraryPath: LibraryPathRow;
    let context: FileScannerContext;
    let seriesCache: Map<string, string>;
    let seasonCache: Map<string, string>;
    let announcements: Set<string>;

    beforeAll(() => {
        sql = getTestDb();
        context = { sql, logger: Logger.for('AbsoluteEpisodeScanTest') };
        vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined);
    });

    afterAll(async () => closeTestDb());

    beforeEach(async () => {
        provider.candidates.clear();
        provider.afterMatched.mockClear();
        provider.afterReclaimed.mockClear();
        writes.setAbsolute.mockClear();
        seriesCache = new Map();
        seasonCache = new Map();
        announcements = new Set();
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-abs-ep-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name)
            VALUES (${`abs-ep-${Date.now()}`}) RETURNING id
        `;
        const [path] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled, provider)
            VALUES (${root}, 'tv', ${group.id}, true, 'tmdb') RETURNING *
        `;
        libraryPath = path;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await sql`DELETE FROM library_paths WHERE id = ${path.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function episodeFile(folder: string, name: string): Promise<string> {
        const directory = join(root, `${TITLE} (2004)`, folder);
        await mkdir(directory, { recursive: true });
        const filePath = join(directory, name);
        await copyFile(FIXTURE, filePath);
        provider.candidates.set(filePath, {
            title: TITLE,
            year: 2004,
            provider: 'tmdb',
            externalId: SHOW_TMDB,
            mediaType: 'tv',
            confidence: 1,
        });
        return filePath;
    }

    const scan = (
        filePath: string,
        knownFiles?: Awaited<ReturnType<typeof loadMediaFilesByPrefix>>,
        hasReclaimCandidates = false,
    ) =>
        processVideoFile(
            sql,
            filePath,
            libraryPath,
            [TMDB],
            context,
            knownFiles,
            undefined,
            undefined,
            hasReclaimCandidates,
            seriesCache,
            seasonCache,
            announcements,
        );

    async function absoluteOf(filePath: string): Promise<number | null> {
        const [row] = await sql<{ absolute_episode: number | null }[]>`
            SELECT absolute_episode FROM media_files WHERE file_path = ${filePath}
        `;
        return row.absolute_episode;
    }

    it('stores the absolute number of a Sonarr anime name on a new file', async () => {
        const file = await episodeFile(
            'Season 9',
            `${TITLE} (2004) - S09E21 - 188 - Duel! Amagai vs. Ichigo [Bluray-720p].mkv`,
        );
        expect(await scan(file)).not.toBe('skipped');
        expect(await absoluteOf(file)).toBe(188);
    });

    it('stores the episode of a bare S01E0422 file as its absolute number', async () => {
        const file = await episodeFile('Season 13', 'S01E0422 - ONE PIECE [GER-JAP].mkv');
        expect(await scan(file)).not.toBe('skipped');
        expect(await absoluteOf(file)).toBe(422);
    });

    it('leaves the column empty for a file name without one', async () => {
        const file = await episodeFile('Season 3', `${TITLE} - S03E01-02 - Career Day.mkv`);
        expect(await scan(file)).not.toBe('skipped');
        expect(await absoluteOf(file)).toBeNull();
    });

    it('rewrites the column when a known path is processed again', async () => {
        const file = await episodeFile(
            'Season 9',
            `${TITLE} (2004) - S09E21 - 188 - Duel! Amagai vs. Ichigo [Bluray-720p].mkv`,
        );
        await scan(file);
        await sql`UPDATE media_files SET absolute_episode = NULL WHERE file_path = ${file}`;
        await scan(file);
        expect(await absoluteOf(file)).toBe(188);
    });

    describe('a known file costs no round-trip unless its number changed', () => {
        const named = `${TITLE} (2004) - S09E21 - 188 - Duel! Amagai vs. Ichigo [Bluray-720p].mkv`;

        it('unchanged file, matching stored value: no UPDATE', async () => {
            const file = await episodeFile('Season 9', named);
            await scan(file);
            const known = await loadMediaFilesByPrefix(sql, root);
            writes.setAbsolute.mockClear();

            await scan(file, known);

            expect(writes.setAbsolute).not.toHaveBeenCalled();
            expect(await absoluteOf(file)).toBe(188);
        });

        it('changed value: updated once', async () => {
            const file = await episodeFile('Season 9', named);
            await scan(file);
            await sql`UPDATE media_files SET absolute_episode = 5 WHERE file_path = ${file}`;
            const known = await loadMediaFilesByPrefix(sql, root);
            writes.setAbsolute.mockClear();

            await scan(file, known);

            expect(writes.setAbsolute).toHaveBeenCalledTimes(1);
            expect(writes.setAbsolute).toHaveBeenCalledWith(
                expect.anything(),
                expect.any(String),
                188,
            );
            expect(await absoluteOf(file)).toBe(188);
        });

        it('the name no longer yields a number: cleared', async () => {
            const file = await episodeFile('Season 3', `${TITLE} - S03E01-02 - Career Day.mkv`);
            await scan(file);
            await sql`UPDATE media_files SET absolute_episode = 77 WHERE file_path = ${file}`;
            const known = await loadMediaFilesByPrefix(sql, root);
            writes.setAbsolute.mockClear();

            await scan(file, known);

            expect(writes.setAbsolute).toHaveBeenCalledWith(
                expect.anything(),
                expect.any(String),
                null,
            );
            expect(await absoluteOf(file)).toBeNull();
        });

        it('a file without a number and without a stored one: no UPDATE', async () => {
            const file = await episodeFile('Season 3', `${TITLE} - S03E01-02 - Career Day.mkv`);
            await scan(file);
            const known = await loadMediaFilesByPrefix(sql, root);
            writes.setAbsolute.mockClear();

            await scan(file, known);

            expect(writes.setAbsolute).not.toHaveBeenCalled();
        });

        it('the per-file path (no bulk map) compares with the row it reads', async () => {
            const file = await episodeFile('Season 9', named);
            await scan(file);
            writes.setAbsolute.mockClear();

            await scan(file);

            expect(writes.setAbsolute).not.toHaveBeenCalled();
        });
    });

    it('the hash-reclaim path stores the absolute number on the reclaimed row', async () => {
        const file = await episodeFile(
            'Season 9',
            `${TITLE} (2004) - S09E21 - 188 - Duel! Amagai vs. Ichigo [Bluray-720p].mkv`,
        );
        const hash = await hashFileHead(file);
        await sql`
            INSERT INTO media_items (title, media_type, status, has_files, is_dismissed, dismissed_at, dismissed_content_hash)
            VALUES ('Reclaimed episode', 'episode', 'active', false, true, NOW(), ${hash})
        `;

        const outcome = await scan(file, undefined, true);

        expect(outcome).toBe('updated');
        expect(provider.afterReclaimed).toHaveBeenCalledTimes(1);
        expect(await absoluteOf(file)).toBe(188);
    });
});
