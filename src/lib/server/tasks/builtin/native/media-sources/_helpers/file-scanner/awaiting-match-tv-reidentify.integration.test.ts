// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A TMDB key added after the first scan identifies the file-name items IN PLACE.
 *
 * Found on a fresh public-image install (2026-10-14): libraries scanned without
 * a TMDB key, key saved afterwards (setup finish screen or Admin -> Settings),
 * then a rescan. Movies came back as NEW TMDB items with the old ones hidden
 * beside them; the series were never repaired at all — their episodes were not
 * flagged `awaiting_provider_match`, so the unchanged-file fast path never
 * re-matched them, series-sync stayed `failed_permanent` and metadata-update
 * `skipped_permanent` ('no-primary-external-id'), since nothing emitted the
 * identity events those stages wait for.
 *
 * Real scanner, real Postgres, real files and ffprobe, the real outbox
 * dispatcher and stage-state service; only the provider search (the same seam
 * awaiting-match-rescan-identity.integration.test.ts stubs) and the
 * fire-and-forget lifecycle enqueue are stubbed.
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

// The lifecycle hooks a rescan fires (afterMetadataChanged and friends) call
// orchestrator.startRun. The real facade boots a whole orchestrator whose own
// PipelineEventDispatcher LISTENs on the outbox and can drain the movie's
// identity.assigned event before drainOutbox() below does (order-dependent red
// on CI shard 3). This test drains the outbox itself, so no orchestrator runs.
vi.mock('../../../../../orchestrator.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    orchestrator: { startRun: vi.fn(async () => ({ runId: 'stub', deduped: false })) },
    getOrchestrator: vi.fn(async () => {
        throw new Error('no orchestrator in this test');
    }),
}));

const { processVideoFile } = await import('./video-processor.js');
const { PipelineEventDispatcher, _clearPipelineEventHandlersForTesting } =
    await import('../../../../../../services/pipeline-event-dispatcher.service.js');
const { StageStateService } = await import('../../../../../../services/stage-state.service.js');
const { TaskRegistry } = await import('../../../../../registry.js');
const { seriesSyncTask } = await import('../../../media-item-tasks.js');
const { metadataUpdateTask } = await import('../../../metadata-sync.js');
const { handleProviderKeyChange } =
    await import('../../../../../../services/provider-key-rematch.service.js');

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');
const TMDB = 'tmdb-metadata-provider';

describe('TMDB key added after a key-less scan: in-place re-identification (real PG)', () => {
    let sql: postgres.Sql;
    let root: string;
    let tvLibrary: LibraryPathRow;
    let movieLibrary: LibraryPathRow;
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
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-key-reidentify-'));
        await mkdir(join(root, 'tv'));
        await mkdir(join(root, 'movies'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`key-reidentify-${Date.now()}`})
            RETURNING id
        `;
        [tvLibrary] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled, provider)
            VALUES (${join(root, 'tv')}, 'tv', ${group.id}, true, 'tmdb')
            RETURNING *
        `;
        [movieLibrary] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled, provider)
            VALUES (${join(root, 'movies')}, 'movie', ${group.id}, true, 'tmdb')
            RETURNING *
        `;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await sql`DELETE FROM library_paths WHERE library_group_id = ${group.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function episodeFile(show: string, season: number, episode: number): Promise<string> {
        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');
        const dir = join(root, 'tv', show, `Season ${s}`);
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, `${show} - S${s}E${e}.mp4`);
        await copyFile(FIXTURE, filePath);
        return filePath;
    }

    async function movieFile(folder: string): Promise<string> {
        const dir = join(root, 'movies', folder);
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, `${folder}.mp4`);
        await copyFile(FIXTURE, filePath);
        return filePath;
    }

    const scan = (filePath: string, library: LibraryPathRow) =>
        processVideoFile(sql, filePath, library, [TMDB], context);

    async function linkedItem(filePath: string): Promise<string> {
        const rows = await sql<{ media_item_id: string }[]>`
            SELECT mfi.media_item_id
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE mf.file_path = ${filePath}
        `;
        expect(rows).toHaveLength(1);
        return rows[0].media_item_id;
    }

    async function seriesOf(episodeId: string): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            SELECT s.id FROM media_items e
            JOIN media_items se ON se.id = e.parent_id
            JOIN media_items s ON s.id = se.parent_id
            WHERE e.id = ${episodeId}::uuid
        `;
        return row.id;
    }

    const countByType = async (type: string): Promise<number> => {
        const [row] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM media_items WHERE media_type = ${type}
        `;
        return row.n;
    };

    const awaiting = async (id: string): Promise<boolean | null> => {
        const [row] = await sql<{ awaiting: boolean | null }[]>`
            SELECT (custom_metadata->>'awaiting_provider_match')::boolean AS awaiting
            FROM media_items WHERE id = ${id}::uuid
        `;
        return row.awaiting;
    };

    /** Stage rows as the key-less install left them (2026-10-14 fresh-install test). */
    async function seedGivenUpStages(seriesId: string, movieId: string): Promise<void> {
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, skipped_reason, completed_at)
            VALUES
                (${seriesId}, 'series-sync', 1, 'failed_permanent', NULL, now()),
                (${seriesId}, 'metadata-update', 1, 'skipped_permanent', 'no-primary-external-id', now()),
                (${movieId}, 'metadata-update', 1, 'skipped_permanent', 'no-primary-external-id', now())
        `;
    }

    async function drainOutbox(): Promise<void> {
        _clearPipelineEventHandlersForTesting();
        const registry = new TaskRegistry();
        registry.registerTask(seriesSyncTask);
        registry.registerTask(metadataUpdateTask);
        const dispatcher = new PipelineEventDispatcher({
            sql,
            isLeader: () => true,
            drainBudgetMs: 30_000,
            stageState: new StageStateService(sql, registry),
        });
        try {
            await dispatcher.tick();
        } finally {
            dispatcher.stop();
        }
    }

    async function stageStatus(id: string, stageId: string): Promise<string | undefined> {
        const [row] = await sql<{ status: string }[]>`
            SELECT status FROM media_item_stage_state
            WHERE media_item_id = ${id}::uuid AND stage_id = ${stageId}
        `;
        return row?.status;
    }

    it('series, seasons, episodes and movies keep their ids, gain the TMDB id, and their given-up stages re-open', async () => {
        const e1 = await episodeFile('Harbor Lights', 1, 1);
        const e2 = await episodeFile('Harbor Lights', 1, 2);
        const movie = await movieFile('Paper Lantern (2004)');

        // 1. Key-less first scan: titles from the file names.
        expect(await scan(e1, tvLibrary)).toBe('added');
        expect(await scan(e2, tvLibrary)).toBe('added');
        expect(await scan(movie, movieLibrary)).toBe('added');
        const ep1 = await linkedItem(e1);
        const ep2 = await linkedItem(e2);
        const movieId = await linkedItem(movie);
        const seriesId = await seriesOf(ep1);
        expect(await seriesOf(ep2)).toBe(seriesId);
        expect(await awaiting(ep1)).toBe(true);
        expect(await awaiting(ep2)).toBe(true);
        expect(await awaiting(movieId)).toBe(true);
        await seedGivenUpStages(seriesId, movieId);
        await sql`DELETE FROM event_outbox`;

        // 2. The key is saved: the trigger asks for exactly these two libraries.
        provider.configured = true;
        const startRun = vi.fn(async () => ({ runId: 'r' }));
        const started = await handleProviderKeyChange(['TMDB_API_KEY'], { sql, startRun });
        expect(started.toSorted()).toEqual([tvLibrary.id, movieLibrary.id].toSorted());
        expect(startRun).toHaveBeenCalledWith(
            'file-library-scan',
            { libraryPathId: tvLibrary.id, mode: 'manual' },
            expect.objectContaining({ idempotencyKey: `provider-key-rematch:${tvLibrary.id}` }),
        );

        // 3. That scan re-matches the awaiting files.
        provider.match = {
            externalId: '9090',
            provider: 'tmdb',
            title: 'Harbour Lights',
            year: 2019,
            mediaType: 'tv',
            confidence: 0.9,
        };
        await scan(e1, tvLibrary);
        await scan(e2, tvLibrary);
        provider.match = {
            externalId: '8080',
            provider: 'tmdb',
            title: 'The Paper Lantern',
            year: 2004,
            mediaType: 'movie',
            confidence: 0.9,
        };
        await scan(movie, movieLibrary);

        // Same rows, no duplicates, nothing hidden.
        expect(await linkedItem(e1)).toBe(ep1);
        expect(await linkedItem(e2)).toBe(ep2);
        expect(await linkedItem(movie)).toBe(movieId);
        expect(await countByType('tv')).toBe(1);
        expect(await countByType('season')).toBe(1);
        expect(await countByType('episode')).toBe(2);
        expect(await countByType('movie')).toBe(1);
        const [{ dismissed }] = await sql<{ dismissed: number }[]>`
            SELECT count(*)::int AS dismissed FROM media_items WHERE is_dismissed
        `;
        expect(dismissed).toBe(0);

        const ids = await sql<{ media_id: string; external_id: string }[]>`
            SELECT media_id, external_id FROM external_ids
            WHERE provider = 'tmdb' AND is_primary ORDER BY external_id
        `;
        expect(ids).toEqual([
            { media_id: movieId, external_id: '8080' },
            { media_id: seriesId, external_id: '9090' },
        ]);
        const titles = await sql<{ id: string; title: string; year: number | null }[]>`
            SELECT id, title, year FROM media_items WHERE id IN (${seriesId}, ${movieId})
        `;
        expect(new Map(titles.map((t) => [t.id, [t.title, t.year]]))).toEqual(
            new Map([
                [seriesId, ['Harbour Lights', 2019]],
                [movieId, ['The Paper Lantern', 2004]],
            ]),
        );
        expect(await awaiting(ep1)).toBeNull();
        expect(await awaiting(ep2)).toBeNull();
        expect(await awaiting(movieId)).toBeNull();

        // 4. identity.assigned reaches the stages through the real dispatcher.
        await drainOutbox();
        expect(await stageStatus(seriesId, 'series-sync')).toBe('pending');
        expect(await stageStatus(seriesId, 'metadata-update')).toBe('pending');
        expect(await stageStatus(movieId, 'metadata-update')).toBe('pending');

        // 5. Settled: the next scan is the unchanged skip, and nothing is left to re-match.
        expect(await scan(e1, tvLibrary)).toBe('skipped');
        expect(await handleProviderKeyChange(['TMDB_API_KEY'], { sql, startRun })).toEqual([]);
    });

    it('a series that already holds another TMDB id is not overwritten', async () => {
        const e1 = await episodeFile('Twin Coast', 1, 1);
        await scan(e1, tvLibrary);
        const ep1 = await linkedItem(e1);
        const seriesId = await seriesOf(ep1);
        // E.g. a Jellyfin-synced or hand-fixed series.
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${seriesId}, 'tmdb', '1111', 'tv', true)
        `;

        provider.configured = true;
        provider.match = {
            externalId: '2222',
            provider: 'tmdb',
            title: 'Twin Coast Redux',
            mediaType: 'tv',
            confidence: 0.9,
        };
        await scan(e1, tvLibrary).catch(() => undefined);

        const ids = await sql<{ external_id: string }[]>`
            SELECT external_id FROM external_ids WHERE media_id = ${seriesId}::uuid
        `;
        expect(ids).toEqual([{ external_id: '1111' }]);
        const [row] = await sql<{ title: string }[]>`
            SELECT title FROM media_items WHERE id = ${seriesId}::uuid
        `;
        expect(row.title).toBe('Twin Coast');
    });

    it('matched id already held by another series: the file moves there, the old series is not renamed or given the id', async () => {
        const e1 = await episodeFile('Harbor Lights', 1, 1);
        await scan(e1, tvLibrary);
        const ep1 = await linkedItem(e1);
        const oldSeries = await seriesOf(ep1);
        const [owner] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, year)
            VALUES ('Harbour Lights', 'tv', 'active', 2019) RETURNING id
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${owner.id}, 'tmdb', '9090', 'tv', true)
        `;

        provider.configured = true;
        provider.match = {
            externalId: '9090',
            provider: 'tmdb',
            title: 'Harbour Lights',
            year: 2019,
            mediaType: 'tv',
            confidence: 0.9,
        };
        await scan(e1, tvLibrary);

        expect(await seriesOf(await linkedItem(e1))).toBe(owner.id);
        const [old] = await sql<{ title: string; ids: number }[]>`
            SELECT title,
                   (SELECT count(*)::int FROM external_ids WHERE media_id = mi.id) AS ids
            FROM media_items mi WHERE id = ${oldSeries}::uuid
        `;
        expect(old).toEqual({ title: 'Harbor Lights', ids: 0 });
        const [{ n }] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM external_ids WHERE external_id = '9090'
        `;
        expect(n).toBe(1);
    });

    it('no usable key, or an unrelated setting: no re-scan is requested', async () => {
        await scan(await movieFile('Quiet Field (2012)'), movieLibrary);
        const startRun = vi.fn(async () => ({ runId: 'r' }));

        provider.configured = false;
        expect(await handleProviderKeyChange(['TMDB_API_KEY'], { sql, startRun })).toEqual([]);
        provider.configured = true;
        expect(await handleProviderKeyChange(['TMDB_LANGUAGE'], { sql, startRun })).toEqual([]);
        expect(startRun).not.toHaveBeenCalled();
    });
});
