// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, stat, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestSeries } from '../../../../tests/integration/fixtures/index.js';
import { runTask } from '@sapd/lumastra-plugin-sdk-testing';
import { chapterSyncTask } from '$lib/server/tasks/builtin/native/media-item-tasks.js';
import { createCatalogService } from './catalog.service.js';
import * as chapterWriter from './file-chapters.service.js';
import { replaceProbedFileChapters } from './file-chapters.service.js';
import { syncSeriesChapters } from './chapter-sync.service.js';
import { setManualFileEpisodes } from './manual-file-links.service.js';

const controls = vi.hoisted(() => ({
    failRefresh: false,
    afterRefresh: null as ((sql: postgres.Sql, id: string) => Promise<void>) | null,
    probe: vi.fn(),
    jellyfin: vi.fn(),
}));
vi.mock('$lib/server/jellyfin/index.js', () => ({
    jellyfinSeriesService: { getItemWithChapters: controls.jellyfin },
}));
vi.mock('$lib/server/utils/ffprobe.js', async (original) => ({
    ...(await original<typeof import('$lib/server/utils/ffprobe.js')>()),
    probeChapters: controls.probe,
}));
vi.mock('$lib/server/database/queries/file-segments.queries.js', async (original) => {
    const actual =
        await original<typeof import('$lib/server/database/queries/file-segments.queries.js')>();
    return {
        ...actual,
        refreshSegmentsForFile: async (sql: postgres.Sql, id: string): Promise<void> => {
            await actual.refreshSegmentsForFile(sql, id);
            await controls.afterRefresh?.(sql, id);
            if (controls.failRefresh) throw new Error('controlled refresh failure');
        },
    };
});

let sql: postgres.Sql;
let root: string;
beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
beforeEach(async () => {
    controls.failRefresh = false;
    controls.afterRefresh = null;
    controls.probe.mockReset();
    controls.jellyfin.mockReset();
    await truncateTables(sql, TEST_TABLES.media);
    root = await mkdtemp(join(tmpdir(), 'chapter-atomic-'));
});
afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{
    fileId: string;
    filePath: string;
    episodeIds: string[];
    seriesId: string;
}> {
    const { seriesId } = await createAndInsertTestSeries(sql, {
        seasonCount: 1,
        episodesPerSeason: 2,
    });
    const episodes = await sql<
        { id: string }[]
    >`SELECT ep.id FROM media_items ep JOIN media_items season ON season.id=ep.parent_id WHERE season.parent_id=${seriesId} AND ep.media_type='episode' ORDER BY ep.episode_number`;
    const filePath = join(root, 'Lantern Shore S01E01E02.mkv');
    await writeFile(filePath, 'verified physical fixture');
    const st = await stat(filePath);
    const fileId = crypto.randomUUID();
    await sql`INSERT INTO media_files(id,file_path,duration_seconds,file_mtime,file_size_bytes) VALUES(${fileId},${filePath},600,${st.mtime},${st.size})`;
    for (const episode of episodes)
        await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES(${fileId},${episode.id},true)`;
    return { fileId, filePath, seriesId, episodeIds: episodes.map((ep) => ep.id) };
}
const chapters = [
    { index: 0, title: 'Pilot Lantern', startTimeMs: 0, endTimeMs: 240000 },
    { index: 1, title: 'Across the Harbor', startTimeMs: 240000, endTimeMs: 600000 },
];

it('rejects an older result after a newer writer, and stat:null never changes trusted rows/windows', async () => {
    const f = await fixture();
    const old = await stat(f.filePath);
    await utimes(f.filePath, new Date(), new Date(old.mtime.getTime() + 5000));
    const fresh = await stat(f.filePath);
    await sql`UPDATE media_files SET file_mtime=${fresh.mtime} WHERE id=${f.fileId}`;
    expect(
        await replaceProbedFileChapters(sql, f.fileId, {
            success: true,
            chapters,
            stat: { mtime: fresh.mtime, size: fresh.size },
        }),
    ).toBe(true);
    const before =
        await sql`SELECT chapter_name,start_ticks FROM episode_chapters WHERE file_id=${f.fileId} ORDER BY chapter_index`;
    const windows =
        await sql`SELECT media_item_id,start_offset_ms,end_offset_ms FROM media_file_items WHERE file_id=${f.fileId} ORDER BY media_item_id`;
    expect(
        await replaceProbedFileChapters(sql, f.fileId, {
            success: true,
            chapters: [],
            stat: { mtime: old.mtime, size: old.size },
        }),
    ).toBe(false);
    expect(
        await replaceProbedFileChapters(sql, f.fileId, { success: true, chapters: [], stat: null }),
    ).toBe(false);
    expect(
        await sql`SELECT chapter_name,start_ticks FROM episode_chapters WHERE file_id=${f.fileId} ORDER BY chapter_index`,
    ).toEqual(before);
    expect(
        await sql`SELECT media_item_id,start_offset_ms,end_offset_ms FROM media_file_items WHERE file_id=${f.fileId} ORDER BY media_item_id`,
    ).toEqual(windows);
    const [marker] =
        await sql`SELECT chapters_probed_mtime=file_mtime AS valid FROM media_files WHERE id=${f.fileId}`;
    expect(marker.valid).toBe(true);
});

it('rolls back chapter rows, marker and partially refreshed windows on refresh failure and permits retry', async () => {
    const f = await fixture();
    const st = await stat(f.filePath);
    await sql`INSERT INTO episode_chapters(file_id,chapter_index,chapter_name,start_ticks,source) VALUES(${f.fileId},0,'Old chapter',0,'file')`;
    await sql`UPDATE media_file_items SET start_offset_ms=123,end_offset_ms=456 WHERE file_id=${f.fileId}`;
    const before =
        await sql`SELECT media_item_id,start_offset_ms,end_offset_ms FROM media_file_items WHERE file_id=${f.fileId} ORDER BY media_item_id`;
    controls.failRefresh = true;
    await expect(
        replaceProbedFileChapters(sql, f.fileId, {
            success: true,
            chapters,
            stat: { mtime: st.mtime, size: st.size },
        }),
    ).rejects.toThrow('controlled refresh failure');
    expect(
        (await sql`SELECT chapter_name FROM episode_chapters WHERE file_id=${f.fileId}`)[0]
            .chapter_name,
    ).toBe('Old chapter');
    expect(
        (await sql`SELECT chapters_probed_mtime FROM media_files WHERE id=${f.fileId}`)[0]
            .chapters_probed_mtime,
    ).toBeNull();
    expect(
        await sql`SELECT media_item_id,start_offset_ms,end_offset_ms FROM media_file_items WHERE file_id=${f.fileId} ORDER BY media_item_id`,
    ).toEqual(before);
    controls.failRefresh = false;
    expect(
        await replaceProbedFileChapters(sql, f.fileId, {
            success: true,
            chapters,
            stat: { mtime: st.mtime, size: st.size },
        }),
    ).toBe(true);
});

it('rolls back every write when cancelled after the real segment refresh inside the transaction', async () => {
    const f = await fixture();
    const st = await stat(f.filePath);
    await sql`UPDATE media_files SET file_mtime=NULL,file_size_bytes=NULL WHERE id=${f.fileId}`;
    await sql`INSERT INTO episode_chapters(file_id,chapter_index,chapter_name,start_ticks,source) VALUES(${f.fileId},0,'Old chapter',0,'file')`;
    await sql`UPDATE media_file_items SET start_offset_ms=123,end_offset_ms=456 WHERE file_id=${f.fileId}`;
    const originalChapters =
        await sql`SELECT * FROM episode_chapters WHERE file_id=${f.fileId} ORDER BY chapter_index`;
    const originalFiles = await sql`SELECT * FROM media_files WHERE id=${f.fileId}`;
    const originalWindows =
        await sql`SELECT * FROM media_file_items WHERE file_id=${f.fileId} ORDER BY media_item_id`;
    const abort = new AbortController();
    let refreshed = false;
    controls.afterRefresh = async (tx, id) => {
        expect(id).toBe(f.fileId);
        expect(
            await tx`SELECT * FROM media_file_items WHERE file_id=${id} ORDER BY media_item_id`,
        ).not.toEqual(originalWindows);
        expect(
            (await tx`SELECT file_mtime,file_size_bytes FROM media_files WHERE id=${id}`)[0],
        ).toEqual({ file_mtime: st.mtime, file_size_bytes: st.size });
        refreshed = true;
        abort.abort();
    };
    await expect(
        replaceProbedFileChapters(
            sql,
            f.fileId,
            { success: true, chapters, stat: { mtime: st.mtime, size: st.size } },
            undefined,
            { signal: abort.signal },
        ),
    ).rejects.toThrow('Chapter storage cancelled.');
    expect(refreshed).toBe(true);
    expect(
        await sql`SELECT * FROM episode_chapters WHERE file_id=${f.fileId} ORDER BY chapter_index`,
    ).toEqual(originalChapters);
    expect(await sql`SELECT * FROM media_files WHERE id=${f.fileId}`).toEqual(originalFiles);
    expect(
        await sql`SELECT * FROM media_file_items WHERE file_id=${f.fileId} ORDER BY media_item_id`,
    ).toEqual(originalWindows);
});

it.each([false, true])(
    'chapter-sync successful empty clears prior physical rows and preserves manual=%s windows',
    async (manual) => {
        const f = await fixture();
        const st = await stat(f.filePath);
        await replaceProbedFileChapters(sql, f.fileId, {
            success: true,
            chapters,
            stat: { mtime: st.mtime, size: st.size },
        });
        if (manual)
            await setManualFileEpisodes(sql, f.fileId, f.episodeIds, [
                { startMs: 0, endMs: 250000 },
                { startMs: 250000, endMs: 600000 },
            ]);
        const before =
            await sql`SELECT media_item_id,start_offset_ms,end_offset_ms FROM media_file_items WHERE file_id=${f.fileId} ORDER BY media_item_id`;
        controls.probe.mockResolvedValue({ chapters: [], durationMs: 600000, success: true });
        await syncSeriesChapters(sql, f.episodeIds[0], undefined, undefined, undefined, {
            force: true,
        });
        expect(
            await sql`SELECT chapter_index FROM episode_chapters WHERE file_id=${f.fileId}`,
        ).toHaveLength(0);
        const after =
            await sql`SELECT media_item_id,start_offset_ms,end_offset_ms FROM media_file_items WHERE file_id=${f.fileId} ORDER BY media_item_id`;
        if (manual) expect(after).toEqual(before);
        else expect(after).not.toEqual(before);
        expect(
            (
                await sql`SELECT chapters_probed_mtime=file_mtime AND chapters_probed_size=file_size_bytes AS valid FROM media_files WHERE id=${f.fileId}`
            )[0].valid,
        ).toBe(true);
    },
);

it('forced chapter-sync initializes missing legacy stat fields from verified physical evidence', async () => {
    const f = await fixture();
    await sql`UPDATE media_files SET file_mtime=NULL,file_size_bytes=NULL WHERE id=${f.fileId}`;
    controls.probe.mockResolvedValue({ chapters, durationMs: 600000, success: true });
    const result = await syncSeriesChapters(sql, f.episodeIds[0], undefined, undefined, undefined, {
        force: true,
    });
    expect(result.inaccessibleFiles).toBe(0);
    expect(result.episodesWithChapters).toBe(1);
    expect(
        (
            await sql`SELECT file_mtime IS NOT NULL AND chapters_probed_mtime=file_mtime AND chapters_probed_size=file_size_bytes AS valid FROM media_files WHERE id=${f.fileId}`
        )[0].valid,
    ).toBe(true);
    await sql`UPDATE media_files SET file_size_bytes=file_size_bytes+1 WHERE id=${f.fileId}`;
    const retry = await syncSeriesChapters(sql, f.episodeIds[0], undefined, undefined, undefined, {
        force: true,
    });
    expect(retry.inaccessibleFiles).toBe(1);
    expect(
        (await sql`SELECT file_size_bytes FROM media_files WHERE id=${f.fileId}`)[0]
            .file_size_bytes,
    ).toBe((await stat(f.filePath)).size + 1);
});

it.each(['stable-rejected', 'unstable'])(
    'does not overwrite newer physical chapters via Jellyfin after %s evidence',
    async (kind) => {
        const f = await fixture();
        await createCatalogService(sql).upsertExternalId(f.episodeIds[0], {
            provider: 'jellyfin',
            id: crypto.randomUUID(),
            mediaType: 'episode',
        });
        controls.jellyfin.mockResolvedValue({
            chapters: [{ index: 0, name: 'Fallback overwrite', startPositionTicks: 0 }],
            runTimeTicks: 6000000000,
        });
        controls.probe.mockResolvedValue({ chapters: [], durationMs: 600000, success: true });
        const original = chapterWriter.replaceProbedFileChapters;
        if (kind === 'stable-rejected') {
            vi.spyOn(chapterWriter, 'replaceProbedFileChapters').mockImplementationOnce(
                async (handle, id, oldProbe, physicalPath, options) => {
                    const old = await stat(f.filePath);
                    await utimes(f.filePath, new Date(), new Date(old.mtime.getTime() + 5000));
                    const newer = await stat(f.filePath);
                    await sql`UPDATE media_files SET file_mtime=${newer.mtime} WHERE id=${f.fileId}`;
                    await original(sql, f.fileId, {
                        success: true,
                        chapters,
                        stat: { mtime: newer.mtime, size: newer.size },
                    });
                    return original(handle, id, oldProbe, physicalPath, options);
                },
            );
        } else {
            const before = await stat(f.filePath);
            await original(sql, f.fileId, {
                success: true,
                chapters,
                stat: { mtime: before.mtime, size: before.size },
            });
            controls.probe.mockImplementationOnce(async () => {
                await utimes(f.filePath, new Date(), new Date(before.mtime.getTime() + 5000));
                return { chapters: [], durationMs: 600000, success: true };
            });
        }
        const result = await syncSeriesChapters(
            sql,
            f.episodeIds[0],
            'fallback-user',
            undefined,
            undefined,
            { force: true },
        );
        expect(result.inaccessibleFiles).toBe(1);
        expect(controls.jellyfin).not.toHaveBeenCalled();
        expect(
            (
                await sql`SELECT chapter_name FROM episode_chapters WHERE file_id=${f.fileId} ORDER BY chapter_index`
            ).map((row) => row.chapter_name),
        ).toEqual(chapters.map((chapter) => chapter.title));
    },
);

it('actual chapter task cannot complete a rolled-back refresh and succeeds on a real retry', async () => {
    const f = await fixture();
    await sql`INSERT INTO media_item_stage_state(media_item_id,stage_id,processing_version,status) VALUES(${f.seriesId},'chapter-sync',1,'pending')`;
    controls.probe.mockResolvedValue({ chapters, durationMs: 600000, success: true });
    controls.failRefresh = true;
    await expect(
        runTask(chapterSyncTask, { mediaItemId: f.seriesId, force: true }, { sql }),
    ).rejects.toThrow(/will retry/);
    expect(
        (
            await sql`SELECT status FROM media_item_stage_state WHERE media_item_id=${f.seriesId} AND stage_id='chapter-sync'`
        )[0].status,
    ).toBe('pending');
    expect(
        (await sql`SELECT chapters_probed_mtime FROM media_files WHERE id=${f.fileId}`)[0]
            .chapters_probed_mtime,
    ).toBeNull();
    controls.failRefresh = false;
    expect(
        await runTask(chapterSyncTask, { mediaItemId: f.seriesId, force: true }, { sql }),
    ).toMatchObject({ success: true });
    expect(
        (
            await sql`SELECT status FROM media_item_stage_state WHERE media_item_id=${f.seriesId} AND stage_id='chapter-sync'`
        )[0].status,
    ).toBe('completed');
});
