// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { markFileMissing } from './media-files.queries.js';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    getEpisodeLanguageSummaries,
    getFileLanguageSummaries,
} from './admin-language-summary.queries.js';
let sql: postgres.Sql;
const ep1 = randomUUID(),
    ep2 = randomUUID(),
    empty = randomUUID(),
    fallback = randomUUID();
const defaultFile = randomUUID(),
    alternate = randomUUID(),
    unknown = randomUUID();
beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
    for (const id of [ep1, ep2, empty, fallback])
        await sql`INSERT INTO media_items(id,title,media_type,status) VALUES (${id},'Fictional episode','episode','active')`;
    for (const [id, path, probed] of [
        [defaultFile, '/fictional/default.mkv', true],
        [alternate, '/fictional/alternate.mkv', true],
        [unknown, '/fictional/unknown.mkv', false],
    ] as const)
        await sql`INSERT INTO media_files(id,file_path,probed_at) VALUES (${id},${path},${probed ? new Date() : null})`;
    await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default,sort_order,label) VALUES (${defaultFile},${ep1},true,9,'Japanese cut'),(${alternate},${ep1},false,0,'English cut'),(${defaultFile},${ep2},true,0,null),(${unknown},${fallback},true,0,null)`;
    for (const [type, index, language, isDefault, isForced] of [
        ['audio', 0, 'jpn', true, false],
        ['audio', 1, 'ger', false, false],
        ['subtitle', 2, 'eng', true, false],
        ['subtitle', 3, 'und', false, true],
    ] as const)
        await sql`INSERT INTO media_streams(file_id,stream_type,stream_index,codec,language,is_default,is_forced) VALUES (${defaultFile},${type},${index},'test',${language},${isDefault},${isForced})`;
    await sql`INSERT INTO media_streams(file_id,stream_type,stream_index,codec,language,is_default,is_forced) VALUES (${alternate},'audio',0,'aac','eng',true,false)`;
    await sql`INSERT INTO external_subtitle_files(file_id,subtitle_path,language,format,is_forced,is_sdh) VALUES (${defaultFile},'/fictional/default.fra.forced.ass','fra','ass',true,false)`;
});
it('batches default and alternate languages, shared mappings and sidecars without mixing versions', async () => {
    const tracked = vi.fn((...args: unknown[]) =>
        (sql as unknown as (...values: unknown[]) => unknown)(...args),
    );
    const result = await getEpisodeLanguageSummaries(tracked as unknown as postgres.Sql, [
        ep1,
        ep2,
        empty,
        fallback,
    ]);
    expect(tracked).toHaveBeenCalledTimes(4);
    const first = result.get(ep1)!;
    expect(first.selectedFileId).toBe(defaultFile);
    expect(first.selection).toBe('default');
    const selected = first.files.find((f) => f.fileId === first.selectedFileId)!;
    expect(selected.label).toBe('Japanese cut');
    expect(selected.audio.map((s) => s.language)).toEqual(['jpn', 'ger']);
    expect(selected.subtitles).toEqual([
        { language: 'eng', isDefault: true, isForced: false, source: 'embedded' },
        { language: 'und', isDefault: false, isForced: true, source: 'embedded' },
        { language: 'fra', isDefault: null, isForced: true, source: 'sidecar' },
    ]);
    const other = first.files.find((f) => f.fileId === alternate)!;
    expect(other.audio.map((s) => s.language)).toEqual(['eng']);
    expect(other.subtitles).toEqual([]);
    expect(other.probed).toBe(true);
    expect(result.get(ep2)?.files[0].subtitles).toEqual(selected.subtitles);
    expect(result.get(empty)).toEqual({ selectedFileId: null, selection: 'none', files: [] });
    expect(result.get(fallback)?.selection).toBe('default');
    expect(result.get(fallback)?.files[0].probed).toBe(false);
});
it('retains missing/default scope and unknown language evidence without inventing sidecar defaults', async () => {
    await sql`UPDATE media_files SET is_missing=true WHERE id=${defaultFile}`;
    const files = await getFileLanguageSummaries(sql, [defaultFile, alternate, unknown]);
    expect(files.get(defaultFile)?.isMissing).toBe(true);
    expect(files.get(defaultFile)?.subtitles.at(-1)?.isDefault).toBeNull();
    expect(files.get(unknown)?.audio).toEqual([]);
    expect(files.get(unknown)?.probed).toBe(false);
    const episode = (await getEpisodeLanguageSummaries(sql, [ep1])).get(ep1)!;
    expect(episode.selectedFileId).toBe(defaultFile);
    expect(episode.files.find((f) => f.fileId === alternate)?.audio[0].language).toBe('eng');
});

it('does not mistake the missing-file queue sentinel for a completed inspection', async () => {
    await markFileMissing(sql, unknown);
    const rows = await sql`SELECT probed_at FROM media_files WHERE id=${unknown}`;
    expect(rows[0].probed_at).not.toBeNull();
    const summary = (await getFileLanguageSummaries(sql, [unknown])).get(unknown)!;
    expect(summary).toMatchObject({ probed: false, isMissing: true, audio: [], subtitles: [] });
});

it('returns the linked title original language with the physical file inventory', async () => {
    await sql`INSERT INTO provider_metadata (media_id, provider, metadata) VALUES (${ep1}, 'tmdb', '{"original_language":"ja"}')`;
    const summaries = await getFileLanguageSummaries(sql, [defaultFile]);
    expect(summaries.get(defaultFile)?.originalLanguage).toBe('ja');
});
