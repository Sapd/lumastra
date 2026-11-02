// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A rescan of a filename-only movie must keep its media_items id.
 *
 * Found on a fresh public-image install with no TMDB key (GPU hw-transcode test,
 * 2026-10-01): the wizard scan created each movie as a personal item flagged
 * `awaiting_provider_match`; the next scheduled scan saw the unchanged file,
 * DETACHED it from that item (soft-dismissing it) and re-ran matching — which,
 * still with no provider, minted a brand-new personal item. Watch state,
 * ratings and playlists stayed on the dismissed id; the old id 404'd on
 * /api/playback/<id>/info.
 *
 * Also pinned: title+year version grouping of filename-only movies is
 * deterministic. Two folders whose titles collapse to the same parse once
 * release tags are stripped ("GPUTest h264-1080p-pgs (2026)" and
 * "GPUTest hdr10-4k-pgs (2026)" both parse to "GPUTest pgs" 2026) were merged
 * on one install and kept apart on another — whichever order the 8 concurrent
 * scan slots happened to run in.
 *
 * Real scanner, real Postgres, real files and real ffprobe; only the metadata
 * provider (and the fire-and-forget lifecycle enqueue) is stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import {
    createTestRating,
    ensureTestUser,
    insertTestRating,
} from '../../../../../../../../../tests/integration/fixtures/index.js';
import {
    getTestDb,
    getTestDatabaseUrl,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import type { KnownFileRow } from '../../../../../../database/queries/media-files.queries.js';
import type { FileScannerContext } from './shared.js';
import { hashFileHead } from '../../../../../../utils/file-hash.js';

const provider = vi.hoisted(() => ({
    configured: false,
    /** Search outcome when there is no match: a clean miss or a failed search. */
    error: undefined as undefined | 'auth' | 'unavailable',
    match: null as null | {
        externalId: string;
        provider: string;
        title: string;
        year?: number;
        mediaType: string;
        confidence: number;
    },
    beforeMatch: null as null | (() => Promise<void>),
}));

vi.mock('../../../../../plugin-context.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isProviderConfigured: vi.fn(async () => provider.configured),
}));
vi.mock('../../../../../../services/metadata-matching.service.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    matchFileToMetadata: vi.fn(async () => {
        await provider.beforeMatch?.();
        return provider.match
            ? { matched: true, candidate: provider.match }
            : { matched: false, providerError: provider.error };
    }),
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

describe('rescan of filename-only movies keeps item identity (real PG, real ffprobe)', () => {
    let sql: postgres.Sql;
    let root: string;
    let libraryPath: LibraryPathRow;
    const logger = {
        info: (): void => undefined,
        warn: (): void => undefined,
        error: (): void => undefined,
        debug: (): void => undefined,
    };
    let context: FileScannerContext;

    // The identity events the stages wait for come from the external_ids
    // trigger, which the test setup switches off; this file needs it on.
    let priorOutboxFlag: string | null = null;

    beforeAll(async () => {
        sql = getTestDb();
        context = { sql, logger } as unknown as FileScannerContext;
        const [flag] = await sql<{ value: string }[]>`
            SELECT value FROM feature_flags WHERE key = 'event_outbox_enabled'
        `;
        priorOutboxFlag = flag?.value ?? null;
        await sql`
            INSERT INTO feature_flags (key, value) VALUES ('event_outbox_enabled', 'on')
            ON CONFLICT (key) DO UPDATE SET value = 'on'
        `;
    });

    afterAll(async () => {
        await sql`
            UPDATE feature_flags SET value = ${priorOutboxFlag ?? 'off'}
            WHERE key = 'event_outbox_enabled'
        `;
        await closeTestDb();
    });

    beforeEach(async () => {
        provider.configured = false;
        provider.match = null;
        provider.error = undefined;
        provider.beforeMatch = null;
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-awaiting-rescan-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`awaiting-rescan-${Date.now()}`})
            RETURNING id
        `;
        const [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled, provider)
            VALUES (${root}, 'movie', ${group.id}, true, 'tmdb')
            RETURNING *
        `;
        libraryPath = lp;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await sql`DELETE FROM library_paths WHERE id = ${lp.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function movieFile(folder: string): Promise<string> {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, `${folder}.mp4`);
        await copyFile(FIXTURE, filePath);
        return filePath;
    }

    const scan = (filePath: string, providerIds: string[] = [TMDB], abortSignal?: AbortSignal) =>
        processVideoFile(sql, filePath, libraryPath, providerIds, context, undefined, abortSignal);

    /** Not aborted at processVideoFile's entry check, aborted from then on. */
    function signalAbortedAfterEntryCheck(): AbortSignal {
        const controller = new AbortController();
        let reads = 0;
        Object.defineProperty(controller.signal, 'aborted', { get: () => ++reads > 1 });
        return controller.signal;
    }

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

    async function item(id: string): Promise<{ is_dismissed: boolean; awaiting: boolean | null }> {
        const [row] = await sql<{ is_dismissed: boolean; awaiting: boolean | null }[]>`
            SELECT is_dismissed,
                   (custom_metadata->>'awaiting_provider_match')::boolean AS awaiting
            FROM media_items WHERE id = ${id}::uuid
        `;
        return row;
    }

    const movieCount = async (): Promise<number> => {
        const [row] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM media_items WHERE media_type = 'movie'
        `;
        return row.n;
    };

    it('provider unavailable: an unchanged rescan keeps the same item and dismisses nothing', async () => {
        const filePath = await movieFile('GPUTest h264-10bit-720p (2026)');

        expect(await scan(filePath)).toBe('added');
        const [firstId] = await linkedItems(filePath);
        expect(firstId).toBeDefined();
        expect((await item(firstId)).awaiting).toBe(true);

        // Scheduled rescan, still no TMDB key.
        await scan(filePath);
        await scan(filePath);

        expect(await linkedItems(filePath)).toEqual([firstId]);
        expect(await item(firstId)).toEqual({ is_dismissed: false, awaiting: true });
        expect(await movieCount()).toBe(1);
    });

    it('no provider registered at all: same — the rescan keeps the item', async () => {
        const filePath = await movieFile('Home Movie (2019)');

        expect(await scan(filePath, [])).toBe('added');
        const [firstId] = await linkedItems(filePath);

        await scan(filePath, []);

        expect(await linkedItems(filePath)).toEqual([firstId]);
        expect((await item(firstId)).is_dismissed).toBe(false);
        expect(await movieCount()).toBe(1);
    });

    it('provider now available but no match: keeps the item and stops awaiting', async () => {
        const filePath = await movieFile('Not In TMDB (2021)');
        await scan(filePath);
        const [firstId] = await linkedItems(filePath);

        provider.configured = true;
        await scan(filePath);

        expect(await linkedItems(filePath)).toEqual([firstId]);
        // Matching ran and missed: it is a plain personal item now, so later
        // scans don't re-run matching for it on every pass.
        expect(await item(firstId)).toEqual({ is_dismissed: false, awaiting: null });
        expect(await movieCount()).toBe(1);

        // And the following scan is the cheap unchanged skip.
        expect(await scan(filePath)).toBe('skipped');
        expect(await linkedItems(filePath)).toEqual([firstId]);
    });

    it('provider now available and matching: the movie is identified in place (no duplicate)', async () => {
        const filePath = await movieFile('Real Movie (2010)');
        await scan(filePath);
        const [personalId] = await linkedItems(filePath);

        provider.configured = true;
        provider.match = {
            externalId: '424242',
            provider: 'tmdb',
            title: 'Real Movie',
            year: 2010,
            mediaType: 'movie',
            confidence: 0.95,
        };
        expect(await scan(filePath)).toBe('updated');

        // Same item, now carrying the TMDB id: no second row next to it.
        expect(await linkedItems(filePath)).toEqual([personalId]);
        const [ext] = await sql<{ external_id: string; is_primary: boolean }[]>`
            SELECT external_id, is_primary FROM external_ids
            WHERE media_id = ${personalId}::uuid AND provider = 'tmdb'
        `;
        expect(ext).toEqual({ external_id: '424242', is_primary: true });
        expect(await item(personalId)).toEqual({ is_dismissed: false, awaiting: null });
        expect(await movieCount()).toBe(1);
        // The id write is what re-opens the stages that gave up on the item.
        const events = await sql<{ event_name: string }[]>`
            SELECT event_name FROM event_outbox
            WHERE media_item_id = ${personalId}::uuid AND event_name = 'identity.assigned'
        `;
        expect(events.length).toBeGreaterThan(0);

        // Later scans are the cheap unchanged skip.
        expect(await scan(filePath)).toBe('skipped');
        expect(await linkedItems(filePath)).toEqual([personalId]);
    });

    it('a Keep attempt during provider lookup is rejected, then the match preserves file and user rows', async () => {
        const filePath = await movieFile('Kept During Search (2012)');
        await scan(filePath);
        const [personalId] = await linkedItems(filePath);
        const userId = crypto.randomUUID();
        await ensureTestUser(sql, userId);
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms)
                  VALUES (${userId}, ${personalId}, true, 4321)`;
        await insertTestRating(sql, createTestRating(userId, personalId, 4));
        // The initial scan may leave a pre-probe stat if the fixture was
        // copied while its source was being written. Pin change detection to
        // the current bytes so this regression enters the awaiting-rematch
        // branch rather than testing replacement-file handling.
        const fileStat = await stat(filePath);
        const fileHash = await hashFileHead(filePath);
        await sql`
            UPDATE media_files
            SET file_mtime = ${fileStat.mtime}, file_size_bytes = ${fileStat.size}, file_hash_head = ${fileHash}
            WHERE file_path = ${filePath}
        `;
        const [knownFile] = await sql<KnownFileRow[]>`
            SELECT id, file_path, file_mtime, file_size_bytes, file_hash_head,
                   health_issues, absolute_episode, is_missing, true AS is_linked
            FROM media_files WHERE file_path = ${filePath}
        `;
        expect(knownFile).toBeDefined();
        expect((await item(personalId)).awaiting).toBe(true);
        const [beforeFile] = await sql<{ has_files: boolean }[]>`
            SELECT has_files FROM media_items WHERE id = ${personalId}::uuid
        `;
        expect(beforeFile.has_files).toBe(true);

        let entered!: () => void;
        const atSearch = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let release!: () => void;
        const searchGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        provider.configured = true;
        provider.match = {
            externalId: '616161',
            provider: 'tmdb',
            title: 'Kept During Search',
            year: 2012,
            mediaType: 'movie',
            confidence: 0.95,
        };
        provider.beforeMatch = async () => {
            entered();
            await searchGate;
        };

        const scannerPool = postgres(getTestDatabaseUrl(), {
            max: 1,
            connect_timeout: 5,
        }) as unknown as postgres.Sql;
        try {
            const scanPromise = processVideoFile(
                scannerPool,
                filePath,
                libraryPath,
                [TMDB],
                context,
                new Map([[filePath, knownFile]]),
            );
            await atSearch;
            const { keepPersonalMediaItem, claimPersonalMediaRematch } =
                await import('../../../../../../database/queries/unmatched-files.queries.js');
            expect(await keepPersonalMediaItem(sql, personalId.toUpperCase(), 'test-user')).toBe(
                'rematch_busy',
            );
            release();
            expect(await scanPromise).toBe('updated');
            const retryClaim = await claimPersonalMediaRematch(scannerPool, [personalId]);
            expect(retryClaim).not.toBeNull();
            await retryClaim?.release();
        } finally {
            await scannerPool.end({ timeout: 5 });
        }

        expect(await linkedItems(filePath)).toEqual([personalId]);
        expect(await item(personalId)).toEqual({ is_dismissed: false, awaiting: null });
        expect(
            await sql`SELECT 1 FROM personal_media_dispositions WHERE media_id = ${personalId}::uuid AND disposition = 'kept'`,
        ).toHaveLength(0);
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${personalId}::uuid`,
        ).toHaveLength(1);
        expect(
            await sql`SELECT 1 FROM media_file_items WHERE media_item_id = ${personalId}::uuid`,
        ).toHaveLength(1);
        expect(
            await sql`SELECT 1 FROM user_media_state WHERE user_id = ${userId} AND media_id = ${personalId}::uuid AND is_watched AND resume_position_ms = 4321`,
        ).toHaveLength(1);
        expect(
            await sql`SELECT 1 FROM user_ratings WHERE user_id = ${userId} AND media_id = ${personalId}::uuid AND rating = 4`,
        ).toHaveLength(1);
    });

    it('releases the rematch claim when cancellation arrives during provider lookup', async () => {
        const filePath = await movieFile('Cancelled During Search (2011)');
        await scan(filePath);
        const [personalId] = await linkedItems(filePath);
        let entered!: () => void;
        const atSearch = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let release!: () => void;
        const searchGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        provider.configured = true;
        provider.match = {
            externalId: '515152',
            provider: 'tmdb',
            title: 'Cancelled During Search',
            year: 2011,
            mediaType: 'movie',
            confidence: 0.95,
        };
        provider.beforeMatch = async () => {
            entered();
            await searchGate;
        };
        const controller = new AbortController();
        const scanPromise = scan(filePath, [TMDB], controller.signal);
        await atSearch;
        controller.abort();
        release();

        expect(await scanPromise).toBe('skipped');
        expect(await linkedItems(filePath)).toEqual([personalId]);
        const { keepPersonalMediaItem } =
            await import('../../../../../../database/queries/unmatched-files.queries.js');
        expect(await keepPersonalMediaItem(sql, personalId, 'test-user')).toBe('kept');
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${personalId}::uuid`,
        ).toHaveLength(0);
    });

    it('skips automatic rematching for a kept movie before provider work starts', async () => {
        const filePath = await movieFile('Kept Before Search (2013)');
        await scan(filePath);
        const [personalId] = await linkedItems(filePath);
        const { keepPersonalMediaItem } =
            await import('../../../../../../database/queries/unmatched-files.queries.js');
        expect(await keepPersonalMediaItem(sql, personalId, 'test-user')).toBe('kept');
        provider.configured = true;
        provider.match = {
            externalId: '616162',
            provider: 'tmdb',
            title: 'Kept Before Search',
            year: 2013,
            mediaType: 'movie',
            confidence: 0.95,
        };

        expect(await scan(filePath)).toBe('skipped');
        expect(await linkedItems(filePath)).toEqual([personalId]);
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${personalId}::uuid`,
        ).toHaveLength(0);
        expect(
            await sql`SELECT 1 FROM personal_media_dispositions WHERE media_id = ${personalId}::uuid AND disposition = 'kept'`,
        ).toHaveLength(1);
    });

    it('suppresses rematching when a kept series is reached through an awaiting episode', async () => {
        const tvLibrary = { ...libraryPath, media_type: 'tv' } as LibraryPathRow;
        await sql`UPDATE library_paths SET media_type = 'tv' WHERE id = ${libraryPath.id}`;
        libraryPath = tvLibrary;
        const folder = join(root, 'Kept Series (2014)', 'Season 1');
        await mkdir(folder, { recursive: true });
        const filePath = join(folder, 'Kept Series (2014) S01E01.mp4');
        await copyFile(FIXTURE, filePath);
        expect(await scan(filePath)).toBe('added');
        const [episodeId] = await linkedItems(filePath);
        const [series] = await sql<{ id: string }[]>`
            SELECT s.id
            FROM media_items episode
            JOIN media_items parent ON parent.id = episode.parent_id
            JOIN media_items s ON s.id = CASE WHEN parent.media_type = 'season' THEN parent.parent_id ELSE parent.id END
            WHERE episode.id = ${episodeId}::uuid AND s.media_type = 'tv'
        `;
        expect(series).toBeDefined();
        const { keepPersonalMediaItem } =
            await import('../../../../../../database/queries/unmatched-files.queries.js');
        expect(await keepPersonalMediaItem(sql, series.id, 'test-user')).toBe('kept');
        provider.configured = true;
        provider.match = {
            externalId: '717171',
            provider: 'tmdb',
            title: 'Kept Series',
            year: 2014,
            mediaType: 'tv',
            confidence: 0.95,
        };

        expect(await scan(filePath)).toBe('skipped');
        expect(await linkedItems(filePath)).toEqual([episodeId]);
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${series.id}::uuid`,
        ).toHaveLength(0);
        expect(
            await sql`SELECT 1 FROM personal_media_dispositions WHERE media_id = ${series.id}::uuid AND disposition = 'kept'`,
        ).toHaveLength(1);
    });

    it('a locked movie is identified in place but keeps its own title', async () => {
        const filePath = await movieFile('Locked Movie (2009)');
        await scan(filePath);
        const [personalId] = await linkedItems(filePath);
        await sql`
            UPDATE media_items SET title = 'My Title', metadata_locked = true
            WHERE id = ${personalId}::uuid
        `;

        provider.configured = true;
        provider.match = {
            externalId: '434343',
            provider: 'tmdb',
            title: 'Locked Movie: The Cut',
            year: 2010,
            mediaType: 'movie',
            confidence: 0.95,
        };
        await scan(filePath);

        expect(await linkedItems(filePath)).toEqual([personalId]);
        const [row] = await sql<{ title: string; year: number | null; tmdb: string | null }[]>`
            SELECT title, year,
                   (SELECT external_id FROM external_ids
                    WHERE media_id = mi.id AND provider = 'tmdb') AS tmdb
            FROM media_items mi WHERE id = ${personalId}::uuid
        `;
        expect(row).toEqual({ title: 'My Title', year: 2009, tmdb: '434343' });
    });

    it('matched id already held by another item: the file moves there (merge, not a second copy)', async () => {
        const filePath = await movieFile('Known Movie (2011)');
        await scan(filePath);
        const [personalId] = await linkedItems(filePath);
        const [owner] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, year)
            VALUES ('Known Movie', 'movie', 'active', 2011) RETURNING id
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${owner.id}, 'tmdb', '515151', 'movie', true)
        `;

        provider.configured = true;
        provider.match = {
            externalId: '515151',
            provider: 'tmdb',
            title: 'Known Movie',
            year: 2011,
            mediaType: 'movie',
            confidence: 0.95,
        };
        await scan(filePath);

        expect(await linkedItems(filePath)).toEqual([owner.id]);
        expect((await item(personalId)).is_dismissed).toBe(true);
        const [{ n }] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM external_ids WHERE external_id = '515151'
        `;
        expect(n).toBe(1);
    });

    it.each([
        ['the search fails (outage, rate limit)', 'unavailable'],
        ['the key is rejected', 'auth'],
    ] as const)(
        'provider configured but %s: keeps the item AND the awaiting flag',
        async (_label, error) => {
            const filePath = await movieFile(`Outage Movie ${error} (2018)`);
            await scan(filePath);
            const [firstId] = await linkedItems(filePath);

            provider.configured = true;
            provider.error = error;
            expect(await scan(filePath)).toBe('skipped');

            expect(await linkedItems(filePath)).toEqual([firstId]);
            // No answer about this file: it must be retried once the provider is back.
            expect(await item(firstId)).toEqual({ is_dismissed: false, awaiting: true });
            expect(await movieCount()).toBe(1);
            const { keepPersonalMediaItem } =
                await import('../../../../../../database/queries/unmatched-files.queries.js');
            expect(await keepPersonalMediaItem(sql, firstId, 'test-user')).toBe('kept');
        },
    );

    it('a rematch cancelled mid-way keeps the item and the awaiting flag', async () => {
        const filePath = await movieFile('Cancelled Movie (2017)');
        await scan(filePath);
        const [firstId] = await linkedItems(filePath);

        provider.configured = true;
        expect(await scan(filePath, [TMDB], signalAbortedAfterEntryCheck())).toBe('skipped');

        expect(await linkedItems(filePath)).toEqual([firstId]);
        expect(await item(firstId)).toEqual({ is_dismissed: false, awaiting: true });
    });

    it('a file already on another item too: a missed rematch detaches nothing', async () => {
        const filePath = await movieFile('Shared File Movie (2016)');
        await scan(filePath);
        const [awaitingId] = await linkedItems(filePath);
        const [other] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, has_files)
            VALUES ('Other Owner', 'movie', 'active', true) RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (media_item_id, file_id, is_default)
            SELECT ${other.id}, id, true FROM media_files WHERE file_path = ${filePath}
        `;

        provider.configured = true;
        provider.error = 'unavailable';
        await scan(filePath);

        expect(await linkedItems(filePath)).toEqual([awaitingId, other.id].toSorted());
        expect(await item(awaitingId)).toEqual({ is_dismissed: false, awaiting: true });
    });

    it('a rematch never reclaims a dismissed item by hash — it asks the provider', async () => {
        const filePath = await movieFile('Reclaim Bait Movie (2015)');
        await scan(filePath);
        const [currentId] = await linkedItems(filePath);
        // What the old bug left behind: an earlier, soft-dismissed personal item
        // of this very file, with its head hash stamped.
        const [ghost] = await sql<{ id: string }[]>`
            INSERT INTO media_items (
                title, media_type, status, has_files, is_dismissed, dismissed_at,
                dismissed_content_hash
            )
            VALUES (
                'Reclaim Bait Movie', 'movie', 'active', false, true, now(),
                ${await hashFileHead(filePath)}
            )
            RETURNING id
        `;

        provider.configured = true;
        await scan(filePath);

        expect(await linkedItems(filePath)).toEqual([currentId]);
        expect((await item(currentId)).is_dismissed).toBe(false);
        expect((await item(ghost.id)).is_dismissed).toBe(true);
    });

    it('different non-Latin titles are never grouped as versions of one item', async () => {
        // Both used to normalize to "" and so matched each other.
        const a = await movieFile('東京物語 (1953)');
        const b = await movieFile('七人の侍 (1953)');
        await scan(a);
        await scan(b);

        const [itemA] = await linkedItems(a);
        const [itemB] = await linkedItems(b);
        expect(itemA).toBeDefined();
        expect(itemB).toBeDefined();
        expect(itemB).not.toBe(itemA);
        expect(await movieCount()).toBe(2);
    });

    it('title+year version grouping is deterministic under concurrent scan slots', async () => {
        // Each pair parses to ONE title + year once release tags are stripped
        // ("GPUTest pgs" 2026 for the first). Several pairs at once, because a
        // single pair only loses the race some of the time.
        const pairs: Array<[string, string]> = [
            ['GPUTest h264-1080p-pgs (2026)', 'GPUTest hdr10-4k-pgs (2026)'],
            ['Alpha Film 1080p (2001)', 'Alpha Film 2160p (2001)'],
            ['Bravo Film 720p (2002)', 'Bravo Film 1080p (2002)'],
            ['Charlie Film 1080p (2003)', 'Charlie Film 2160p (2003)'],
            ['Delta Film 720p (2004)', 'Delta Film 2160p (2004)'],
            ['Echo Film 1080p (2005)', 'Echo Film 720p (2005)'],
        ];
        const files = await Promise.all(
            pairs.map(async ([a, b]) => [await movieFile(a), await movieFile(b)] as const),
        );

        // The bulk scan runs up to 8 files at once.
        await Promise.all(files.flat().map((f) => scan(f)));

        const itemsPerPair = async (): Promise<Array<[string[], string[]]>> =>
            Promise.all(files.map(async ([a, b]) => [await linkedItems(a), await linkedItems(b)]));
        const first = await itemsPerPair();
        for (const [a, b] of first) {
            expect(a).toHaveLength(1);
            expect(b).toEqual(a);
        }
        expect(await movieCount()).toBe(pairs.length);

        // ...and stays that way on the rescan.
        await Promise.all(files.flat().map((f) => scan(f)));
        expect(await itemsPerPair()).toEqual(first);
        expect(await movieCount()).toBe(pairs.length);
    });
});
