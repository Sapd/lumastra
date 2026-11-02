// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
    getTestDb,
    getTestDatabaseUrl,
} from '../../../../tests/integration/setup/test-database.js';
import {
    attachFileToItem,
    recordRangeSupersededFile,
} from '../database/queries/media-files.queries.js';
import {
    getRangeMappingGraph,
    getAdminRangeMappings,
    informationalRangeFileSql,
} from '../database/queries/range-mapping-proof.queries.js';
import {
    observeRangeParticipant,
    recordCurrentRangeMappingProof,
} from './range-mapping-proof.service.js';
import {
    recordStubIfRangeFullySuperseded,
    partitionSupersededRangeFiles,
} from '../tasks/builtin/native/media-sources/_helpers/file-scanner/multi-episode-links.js';
import { loadMediaFilesByPrefix } from '../database/queries/media-files.queries.js';
import { getFileHealthPage } from '../database/queries/file-health-page.queries.js';
import { createCatalogService } from './catalog.service.js';
import * as presence from '../utils/file-presence.js';

const sql = getTestDb();
let root: string, group: string, series: string, season: string, range: string, fileId: string;
let dedicated: string[], episodes: string[], paths: string[];
const args = (): {
    fileId: string;
    seasonId: string;
    first: number;
    last: number;
    dedicatedIds: string[];
} => ({ fileId, seasonId: season, first: 1, last: 2, dedicatedIds: dedicated });
async function current(): Promise<boolean> {
    return (
        await sql<
            { current: boolean }[]
        >`SELECT current_range_mapping_proof(${fileId}::uuid) AS current`
    )[0].current;
}
async function informational(): Promise<boolean> {
    return (
        await sql<
            { value: boolean }[]
        >`SELECT ${informationalRangeFileSql(sql, sql`${fileId}::uuid`)} AS value`
    )[0].value;
}
async function record(): Promise<boolean> {
    return recordCurrentRangeMappingProof(sql, args());
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'range-proof-'));
    group = randomUUID();
    series = randomUUID();
    season = randomUUID();
    await sql`INSERT INTO library_groups (id, name) VALUES (${group}, ${group})`;
    await sql`INSERT INTO library_paths (path, media_type, library_group_id) VALUES (${root}, 'tv', ${group})`;
    await sql`INSERT INTO media_items (id, title, media_type, library_group_id) VALUES (${series}, 'Lantern Station', 'tv', ${group})`;
    await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, library_group_id) VALUES (${season}, 'Season 1', 'season', ${series}, 1, ${group})`;
    range = join(root, 'Lantern Station S01E01E02.mkv');
    paths = [1, 2].map((n) => join(root, `Lantern Station S01E0${n}.mkv`));
    dedicated = [];
    episodes = [];
    for (let n = 1; n <= 2; n++) {
        const episode = randomUUID(),
            file = randomUUID();
        await writeFile(paths[n - 1], `dedicated physical fixture ${n}`);
        const st = await stat(paths[n - 1]);
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, library_group_id)
            VALUES (${episode}, ${`Episode ${n}`}, 'episode', ${season}, 1, ${n}, ${group})`;
        await sql`INSERT INTO media_files (id, file_path, library_group_id, file_mtime, file_size_bytes) VALUES (${file}, ${paths[n - 1]}, ${group}, ${st.mtime}, ${st.size})`;
        await attachFileToItem(sql, file, episode);
        dedicated.push(file);
        episodes.push(episode);
    }
    await writeFile(range, 'combined physical fixture');
    const st = await stat(range);
    await recordRangeSupersededFile(sql, {
        filePath: range,
        libraryGroupId: group,
        supersededBy: paths,
        mtime: st.mtime,
        size: st.size,
    });
    fileId = (await sql<{ id: string }[]>`SELECT id FROM media_files WHERE file_path = ${range}`)[0]
        .id;
});
afterEach(async () => {
    vi.restoreAllMocks();
    await sql`DELETE FROM media_items WHERE library_group_id = ${group}`;
    await sql`DELETE FROM media_files WHERE library_group_id = ${group}`;
    await sql`DELETE FROM library_paths WHERE library_group_id = ${group}`;
    await sql`DELETE FROM library_groups WHERE id = ${group}`;
    await rm(root, { recursive: true, force: true });
});

describe('positive dated current range mapping', () => {
    it('legacy paths and nominal links alone remain unproven, then records all physical participants', async () => {
        expect(await current()).toBe(false);
        expect(await informational()).toBe(false);
        const graph = await getRangeMappingGraph(sql, args());
        expect(graph, 'positive graph').not.toBeNull();
        for (const file of graph!.files)
            expect(
                await observeRangeParticipant(file, graph!.root.path),
                JSON.stringify(file),
            ).not.toBeNull();
        expect(await record()).toBe(true);
        expect(await current()).toBe(true);
        expect(await informational()).toBe(true);
        const actionablePage = await getFileHealthPage(sql, { scope: 'actionable' });
        const informationPage = await getFileHealthPage(sql, { scope: 'informational' });
        expect(actionablePage.actionable).toBe(0);
        expect(informationPage.informational).toBe(1);
        expect(informationPage.files[0]?.file_id).toBe(fileId);
        expect(informationPage.files[0]?.rangeMapping?.state).toBe('current');
        const mapping = (await getAdminRangeMappings(sql, [fileId])).get(fileId)!;
        expect(mapping.state).toBe('current');
        expect(mapping.proof?.participants.map((p) => p.fileId)).toEqual([fileId, ...dedicated]);
        const known = await loadMediaFilesByPrefix(sql, root);
        expect(
            await partitionSupersededRangeFiles([range], known, new Set([range, ...paths]), sql),
        ).toEqual({ process: [], superseded: [range] });
    });
    it('raw recording preserves a newer concurrent source and every other warning', async () => {
        const [before] = await sql<
            { version: string }[]
        >`SELECT xmin::text AS version FROM media_files WHERE id = ${fileId}`;
        const st = await stat(range);
        await sql`UPDATE media_files SET file_size_bytes = 999,
            health_issues = health_issues || '[{"type":"video_decode_gaps","detected_at":"2026-10-25T00:00:00Z","detail":"newer raw warning"}]'::jsonb WHERE id = ${fileId}`;
        await recordRangeSupersededFile(sql, {
            filePath: range,
            libraryGroupId: group,
            supersededBy: paths,
            mtime: st.mtime,
            size: st.size,
            expectedVersion: before.version,
        });
        const [after] =
            await sql`SELECT file_size_bytes, health_issues FROM media_files WHERE id = ${fileId}`;
        expect(Number(after.file_size_bytes)).toBe(999);
        expect(after.health_issues.map((issue: { type: string }) => issue.type)).toEqual([
            'range_superseded',
            'video_decode_gaps',
        ]);
        expect(await current()).toBe(false);
    });
    it('normal range recording can establish a new stat generation after physical replacement', async () => {
        await writeFile(range, 'replacement combined physical fixture with a changed size');
        expect(await recordStubIfRangeFullySuperseded(sql, range, season, group)).toBe(true);
        expect(await current()).toBe(true);
    });
    it('an empty or changed legacy path record cannot adopt an older otherwise-current proof', async () => {
        expect(await record()).toBe(true);
        await sql`UPDATE media_files SET health_issues = jsonb_set(health_issues, '{0,superseded_by}', '[]') WHERE id = ${fileId}`;
        expect(await current()).toBe(false);
        expect(await informational()).toBe(false);
    });
    it('preserves mixed raw warnings and health/probe bookkeeping cannot invent new bytes', async () => {
        expect(await record()).toBe(true);
        await sql`UPDATE media_files SET probed_at = NOW(), keyframes = '[0,1]', health_issues = health_issues || '[{"type":"video_decode_gaps","detected_at":"2026-10-01T00:00:00Z","detail":"retained original"}]'::jsonb WHERE id = ${fileId}`;
        expect(await current()).toBe(true);
        expect(await informational()).toBe(false);
        expect(
            (await sql`SELECT health_issues FROM media_files WHERE id = ${fileId}`)[0]
                .health_issues,
        ).toHaveLength(2);
    });
    it.each(['missing', 'transient', 'symlink', 'changed', 'partial'] as const)(
        'cannot record %s physical witnesses',
        async (kind) => {
            if (kind === 'missing') await rm(paths[1]);
            if (kind === 'transient')
                vi.spyOn(presence, 'assessFilePresence').mockResolvedValue('transient');
            if (kind === 'symlink') {
                await rm(paths[1]);
                await symlink('/etc/hosts', paths[1]);
            }
            if (kind === 'changed') await writeFile(paths[1], 'new bytes');
            if (kind === 'partial')
                await sql`UPDATE media_files SET is_missing = true WHERE id = ${dedicated[1]}`;
            expect(await record()).toBe(false);
            expect(await current()).toBe(false);
            expect(
                (await sql`SELECT health_issues FROM media_files WHERE id = ${fileId}`)[0]
                    .health_issues,
            ).toHaveLength(1);
        },
    );
    it.each([
        'content',
        'path',
        'unlink',
        'window',
        'manual',
        'ancestry',
        'library',
        'source',
        'provider',
        'default-version',
    ] as const)('invalidates %s graph drift without mutating raw issues', async (kind) => {
        expect(await record()).toBe(true);
        if (kind === 'content')
            await sql`UPDATE media_files SET file_hash_head = 'new-generation' WHERE id = ${dedicated[0]}`;
        if (kind === 'path')
            await sql`UPDATE media_files SET file_path = file_path || '.moved' WHERE id = ${dedicated[0]}`;
        if (kind === 'unlink')
            await sql`DELETE FROM media_file_items WHERE file_id = ${dedicated[0]}`;
        if (kind === 'window')
            await sql`UPDATE media_file_items SET start_offset_ms = 100 WHERE file_id = ${dedicated[0]}`;
        if (kind === 'manual')
            await sql`UPDATE media_file_items SET offset_source = 'manual' WHERE file_id = ${dedicated[0]}`;
        if (kind === 'ancestry')
            await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${episodes[0]}`;
        if (kind === 'library')
            await sql`UPDATE media_files SET library_group_id = NULL WHERE id = ${dedicated[0]}`;
        if (kind === 'source')
            await sql`UPDATE library_paths SET provider = 'tvdb' WHERE library_group_id = ${group}`;
        if (kind === 'provider')
            await createCatalogService(sql).upsertExternalId(series, {
                provider: 'tmdb',
                id: String(9900000 + Math.floor(Math.random() * 1000000)),
                mediaType: 'tv',
                source: 'test',
            });
        if (kind === 'default-version')
            await sql`UPDATE media_file_items SET sort_order = 1 WHERE file_id = ${dedicated[0]}`;
        expect(await current()).toBe(false);
        expect(await informational()).toBe(false);
        expect(
            (await sql`SELECT health_issues FROM media_files WHERE id = ${fileId}`)[0]
                .health_issues,
        ).toHaveLength(1);
    });
    it('missing current physical participant forces scanner processing despite a dated graph observation', async () => {
        expect(await record()).toBe(true);
        await rm(paths[1]);
        const known = await loadMediaFilesByPrefix(sql, root);
        expect(
            (await partitionSupersededRangeFiles([range], known, new Set([range, ...paths]), sql))
                .process,
        ).toEqual([range]);
        await recordStubIfRangeFullySuperseded(sql, range, season, group);
        expect(await current()).toBe(false);
    });
    it('rejects source drift during the physical observation and honors cancellation', async () => {
        const real = presence.assessFilePresence;
        vi.spyOn(presence, 'assessFilePresence').mockImplementationOnce(async (...input) => {
            await sql`UPDATE media_file_items SET sort_order = 2 WHERE file_id = ${dedicated[0]}`;
            return real(...input);
        });
        expect(await record()).toBe(false);
        const controller = new AbortController();
        controller.abort();
        expect(
            await recordCurrentRangeMappingProof(sql, { ...args(), signal: controller.signal }),
        ).toBe(false);
        expect(await current()).toBe(false);
    });
    it('busy source owner abstains via savepoint without deadlock or a stale proof', async () => {
        const other = postgres(getTestDatabaseUrl(), { max: 1 });
        try {
            await other.begin(async (tx) => {
                await tx`SELECT id FROM media_files WHERE id = ${dedicated[0]} FOR UPDATE`;
                expect(await record()).toBe(false);
            });
            expect(await current()).toBe(false);
        } finally {
            await other.end();
        }
    });
    it('does not store proof or raw stub beyond a caller rollback', async () => {
        await expect(
            sql.begin(async (raw) => {
                const tx = raw as unknown as postgres.Sql;
                await recordStubIfRangeFullySuperseded(tx, range, season, group);
                expect(
                    (await tx`SELECT current_range_mapping_proof(${fileId}::uuid) AS current`)[0]
                        .current,
                ).toBe(true);
                throw new Error('owner witness drift');
            }),
        ).rejects.toThrow('owner witness drift');
        expect(await current()).toBe(false);
    });
    it('bounded arbitrary JSON always returns false without unsafe expansions/casts', async () => {
        expect(await record()).toBe(true);
        const [saved] = await sql<
            { proof: postgres.JSONValue }[]
        >`SELECT proof FROM file_range_mapping_proofs WHERE file_id = ${fileId}`;
        const malformed: unknown[] = [
            null,
            [],
            'text',
            123,
            {},
            { version: 1, participants: {} },
            { version: 2, observedAt: new Date().toISOString(), participants: [] },
            { version: 1, observedAt: '2026-99-99T00:00:00.000Z', participants: [] },
            {
                version: 1,
                observedAt: new Date().toISOString(),
                participants: Array(10000).fill({}),
            },
            { version: 1, observedAt: 'x'.repeat(100000), participants: [] },
        ];
        for (const proof of malformed) {
            if (proof === null)
                await sql`UPDATE file_range_mapping_proofs SET proof = 'null'::jsonb WHERE file_id = ${fileId}`;
            else
                await sql`UPDATE file_range_mapping_proofs SET proof = ${sql.json(proof as postgres.JSONValue)} WHERE file_id = ${fileId}`;
            expect(await current()).toBe(false);
            expect((await getAdminRangeMappings(sql, [fileId])).get(fileId)).toEqual({
                state: 'unproven',
            });
        }
        await sql`UPDATE file_range_mapping_proofs SET proof = ${sql.json(saved.proof)} WHERE file_id = ${fileId}`;
        expect(await current()).toBe(true);
        await sql`UPDATE file_range_mapping_proofs SET first_episode = -2147483648, last_episode = 2147483647 WHERE file_id = ${fileId}`;
        expect(await current()).toBe(false);
        await sql`UPDATE file_range_mapping_proofs SET first_episode = 1, last_episode = 2 WHERE file_id = ${fileId}`;
        const graph = await getRangeMappingGraph(sql, args());
        expect(graph?.claims.map((c) => c.number)).toEqual([1, 2]);
        await sql`UPDATE file_range_mapping_proofs SET dedicated_ids = ${[dedicated[0], dedicated[0]]}::uuid[] WHERE file_id = ${fileId}`;
        expect(await current()).toBe(false);
    });
});
