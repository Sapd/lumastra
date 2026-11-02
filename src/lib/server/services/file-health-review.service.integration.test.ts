// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    listDueFileHealthRechecks,
    FILE_HEALTH_RULE_VERSION,
} from '$lib/server/database/queries/file-health-recheck.queries.js';
import { getFileHealthIssuesForItemTree } from '$lib/server/database/queries/media-files.queries.js';
import { getMediaPreview } from '$lib/server/database/queries/admin-media.queries.js';
import { getHealthSourceSnapshot } from '$lib/server/database/queries/file-health-assessment.queries.js';
import { getFileHealthPage } from '$lib/server/database/queries/file-health-page.queries.js';
import {
    previewFileHealthReview,
    writeFileHealthReview,
    durationReviewTechnicalBlock,
} from './file-health-review.service.js';
import type { AudioTailAssessment } from '$lib/schemas/audio-tail-assessment.js';
import {
    countUnresolvedFailuresByPlugin,
    getFailureTimeline,
} from '$lib/server/database/queries/plugin-failure-events.queries.js';
import { buildTaskFailuresList } from '$lib/server/api/defs/tasks/[taskId]/failures.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { listItemFailureRows } from '$lib/server/database/queries/failure-patterns.queries.js';
import { mediaProbeTask, listFailedItems } from '$lib/server/tasks/builtin/native/media-probe.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
const raw = [
    {
        type: 'truncated_video',
        basis: 'duration_comparison',
        expected_duration: 120,
        actual_duration: 100,
        detected_at: '2026-10-26T00:00:00Z',
    },
];
describe('exact file duration review with real PostgreSQL', () => {
    let sql: postgres.Sql,
        dir: string,
        fileId: string,
        path: string,
        assessment: AudioTailAssessment;
    beforeAll(async () => {
        sql = getTestDb();
        dir = await mkdtemp(join(tmpdir(), 'duration-review-'));
    });
    afterAll(async () => {
        await sql`DELETE FROM media_file_health_reviews WHERE file_id IN (SELECT id FROM media_files WHERE file_path LIKE ${dir + '%'})`;
        await sql`DELETE FROM media_files WHERE file_path LIKE ${dir + '%'}`;
        await rm(dir, { recursive: true, force: true });
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM plugin_failure_events WHERE item_id IN (SELECT id::text FROM media_files WHERE file_path LIKE ${dir + '%'})`;
        await sql`DELETE FROM media_file_health_reviews WHERE file_id IN (SELECT id FROM media_files WHERE file_path LIKE ${dir + '%'})`;
        await sql`DELETE FROM media_files WHERE file_path LIKE ${dir + '%'}`;
        path = join(dir, 'synthetic.mkv');
        await writeFile(path, 'synthetic testing identity');
        const [row] = await sql<
            { id: string }[]
        >`INSERT INTO media_files(file_path,health_issues) VALUES (${path},${sql.json(raw)}) RETURNING id`;
        fileId = row.id;
        const source = (await getHealthSourceSnapshot(sql, fileId))!;
        const physical = await stat(path, { bigint: true });
        assessment = {
            version: 1,
            method: 'ffmpeg-astats-frames-v2',
            measuredAt: new Date().toISOString(),
            thresholdDbfs: -60,
            completeness: 'unverified',
            scope: 'partial',
            observation: 'unknown',
            inventorySignature: 'test',
            inventory: [],
            source: {
                ...source,
                physical: [
                    'stat-v2',
                    physical.ino,
                    physical.size,
                    physical.mtimeNs,
                    physical.ctimeNs,
                ].join(':'),
            },
            limits: { seconds: 180, streams: 8, concurrency: 2, budgetMs: 90000 },
            reasons: ['no_measurable_post_video_interval'],
            streams: [],
            packetTail: { success: true, endedPrematurely: false, hasAudio: false, videoEnd: 100 },
        };
        await sql`UPDATE media_files SET health_tail_assessment=${sql.json(assessment as unknown as postgres.JSONValue)} WHERE id=${fileId}`;
    });
    async function confirm() {
        const p = await previewFileHealthReview(sql, fileId);
        return writeFileHealthReview(
            sql,
            {
                action: 'confirm',
                fileId,
                snapshot: p.snapshot,
                issueKeys: p.findings.filter((x) => x.state === 'needs-review').map((x) => x.key),
            },
            'test-admin',
        );
    }
    it('retains raw evidence/history, refreshes counts, and supports explicit Undo', async () => {
        expect(await confirm()).toBe(1);
        const page = await getFileHealthPage(sql, { scope: 'reviewed' });
        expect(page.files.map((f) => f.file_id)).toContain(fileId);
        expect(page.files.find((f) => f.file_id === fileId)?.health_issues[0].reviewed).toBe(true);
        let p = await previewFileHealthReview(sql, fileId);
        expect(p.history[0].state).toBe('current');
        expect(p.assessment?.completeness).toBe('unverified');
        const [db] = await sql`SELECT health_issues FROM media_files WHERE id=${fileId}`;
        expect(db.health_issues).toEqual(raw);
        expect(
            await writeFileHealthReview(
                sql,
                { action: 'revoke', fileId, reviewId: p.history[0].id },
                'test-admin',
            ),
        ).toBe(true);
        p = await previewFileHealthReview(sql, fileId);
        expect(p.history[0].state).toBe('revoked');
        expect(p.findings[0].state).toBe('needs-review');
    });
    it.each(['source', 'stream', 'assessment', 'finding'] as const)(
        'reopens after changed %s evidence',
        async (kind) => {
            await confirm();
            if (kind === 'source')
                await sql`UPDATE media_files SET file_size_bytes=123 WHERE id=${fileId}`;
            if (kind === 'stream')
                await sql`INSERT INTO media_streams(file_id,stream_index,stream_type,codec) VALUES (${fileId},0,'audio','aac')`;
            if (kind === 'assessment')
                await sql`UPDATE media_files SET health_tail_assessment=jsonb_set(health_tail_assessment,'{observation}','"audible"') WHERE id=${fileId}`;
            if (kind === 'finding')
                await sql`UPDATE media_files SET health_issues=${sql.json([{ ...raw[0], actual_duration: 99 }])} WHERE id=${fileId}`;
            const p = await previewFileHealthReview(sql, fileId);
            expect(p.history[0].state).toBe('outdated');
            expect(
                (await getFileHealthPage(sql, { scope: 'actionable' })).files.map((f) => f.file_id),
            ).toContain(fileId);
        },
    );
    it('rejects stale physical evidence before a write', async () => {
        const p = await previewFileHealthReview(sql, fileId);
        await writeFile(path, 'replacement bytes');
        await expect(
            writeFileHealthReview(
                sql,
                {
                    action: 'confirm',
                    fileId,
                    snapshot: p.snapshot,
                    issueKeys: [p.findings[0].key],
                    reason: 'Expected container padding',
                    evidence: 'Inspected the ending and complete closing credits.',
                },
                'test-admin',
            ),
        ).rejects.toThrow('changed');
        expect((await previewFileHealthReview(sql, fileId)).history).toHaveLength(0);
    });
    it.each(['source', 'stream', 'assessment'] as const)(
        'rejects a stale %s snapshot without notes',
        async (kind) => {
            const p = await previewFileHealthReview(sql, fileId);
            if (kind === 'source')
                await sql`UPDATE media_files SET file_size_bytes=456 WHERE id=${fileId}`;
            if (kind === 'stream')
                await sql`INSERT INTO media_streams(file_id,stream_index,stream_type,codec) VALUES (${fileId},0,'audio','aac')`;
            if (kind === 'assessment')
                await sql`UPDATE media_files SET health_tail_assessment=jsonb_set(health_tail_assessment,'{observation}','"audible"') WHERE id=${fileId}`;
            await expect(
                writeFileHealthReview(
                    sql,
                    {
                        action: 'confirm',
                        fileId,
                        snapshot: p.snapshot,
                        issueKeys: [p.findings[0].key],
                    },
                    'library-admin',
                ),
            ).rejects.toThrow('changed');
            expect((await previewFileHealthReview(sql, fileId)).history).toHaveLength(0);
        },
    );
    it('leaves current accepted warnings alone until input or rules change', async () => {
        assessment.ruleVersion = FILE_HEALTH_RULE_VERSION;
        await sql`UPDATE media_files SET health_tail_assessment=${sql.json(assessment as unknown as postgres.JSONValue)} WHERE id=${fileId}`;
        await confirm();
        expect((await listDueFileHealthRechecks(sql)).map((r) => r.fileId)).not.toContain(fileId);
        expect(
            (await listDueFileHealthRechecks(sql, FILE_HEALTH_RULE_VERSION + 1)).map(
                (r) => r.fileId,
            ),
        ).toContain(fileId);
        await sql`UPDATE media_files SET file_size_bytes=457 WHERE id=${fileId}`;
        expect((await listDueFileHealthRechecks(sql)).map((r) => r.fileId)).toContain(fileId);
    });
    it('stores an honest acceptance action and preserves raw snapshots without required prose', async () => {
        expect(await confirm()).toBe(1);
        const [row] = await sql`SELECT * FROM media_file_health_reviews WHERE file_id=${fileId}`;
        expect(row.raw_issue).toEqual(raw[0]);
        expect(row.assessment_snapshot).toEqual(assessment);
        expect(row.source_snapshot).toMatchObject({
            acceptanceAction: 'keep-file',
            contentInspectionClaimed: false,
        });
        expect(row.reason).toContain('Keep this file');
        expect(row.evidence).toContain('unverified');
        expect(row.decided_by).toBe('test-admin');
        expect(row.decided_at).toBeTruthy();
    });
    it('serializes concurrent confirmations and rejects stale duplicate authorship', async () => {
        const p = await previewFileHealthReview(sql, fileId);
        const request = {
            action: 'confirm' as const,
            fileId,
            snapshot: p.snapshot,
            issueKeys: [p.findings[0].key],
            reason: 'Expected container padding',
            evidence: 'Inspected the ending and complete closing credits.',
        };
        const results = await Promise.allSettled([
            writeFileHealthReview(sql, request, 'first'),
            writeFileHealthReview(sql, request, 'second'),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect((await previewFileHealthReview(sql, fileId)).history).toHaveLength(1);
    });
    it('preserves mixed unknown findings as actionable after reviewing only the duration', async () => {
        await sql`UPDATE media_files SET health_issues=${sql.json([...raw, { type: 'new_unknown_issue', detected_at: '2026-10-26' }])} WHERE id=${fileId}`;
        await confirm();
        expect(
            (await getFileHealthPage(sql, { scope: 'actionable' })).files.map((f) => f.file_id),
        ).toContain(fileId);
    });
    it('projects accepted disposition through mixed-file overview and inspector queries', async () => {
        await sql`UPDATE media_files SET health_issues=${sql.json([...raw, { type: 'new_unknown_issue', detected_at: '2026-10-26' }])} WHERE id=${fileId}`;
        await confirm();
        const [media] = await sql<
            { id: string }[]
        >`INSERT INTO media_items(title,media_type,has_files) VALUES ('Cloud Harbor','movie',true) RETURNING id`;
        try {
            await sql`INSERT INTO media_file_items(file_id,media_item_id) VALUES (${fileId},${media.id})`;
            const tree = await getFileHealthIssuesForItemTree(sql, media.id);
            expect(tree[0].issues[0].reviewed).toBe(true);
            expect(tree[0].issues[0].type).toBe(raw[0].type);
            expect((await getMediaPreview(sql, media.id))?.healthIssues?.[0].reviewed).toBe(true);
        } finally {
            await sql`DELETE FROM media_file_items WHERE media_item_id=${media.id}`;
            await sql`DELETE FROM media_items WHERE id=${media.id}`;
        }
    });
    it('does not accept quiet audio, missing current probes or actual decoder failures', async () => {
        for (const change of [
            { packetTail: undefined },
            { packetTail: { ...assessment.packetTail!, endedPrematurely: true } },
            { reasons: ['decode_failed'] },
            { scope: 'inconclusive' as const, reasons: [] },
            {
                streams: [
                    {
                        index: 0,
                        requested: { start: 1, end: 2 },
                        samples: 0,
                        coverageSeconds: 0,
                        continuous: false,
                        channels: [],
                        reasons: ['decode_failed'],
                    },
                ],
            },
        ]) {
            expect(
                durationReviewTechnicalBlock({
                    ...assessment,
                    observation: 'near_silent',
                    ...change,
                }),
            ).toBeDefined();
        }
        await sql`UPDATE media_files SET health_issues=${sql.json([...raw, { type: 'container_unreadable' }])} WHERE id=${fileId}`;
        const p = await previewFileHealthReview(sql, fileId);
        expect(p.eligible).toBe(false);
        expect(p.blockedReason).toBe('technical-failure');
    });
    it('ignores detection timestamps but invalidates contradictory new premature EOF', async () => {
        await confirm();
        await sql`UPDATE media_files SET health_issues=${sql.json([{ ...raw[0], detected_at: '2026-10-27' }])} WHERE id=${fileId}`;
        expect((await previewFileHealthReview(sql, fileId)).history[0].state).toBe('current');
        await sql`UPDATE media_files SET health_issues=${sql.json([{ ...raw[0], basis: 'premature_eof' }])} WHERE id=${fileId}`;
        expect((await previewFileHealthReview(sql, fileId)).history[0].state).toBe('outdated');
    });
    it('deduplicates canonical findings and keeps older current decisions reachable', async () => {
        await sql`UPDATE media_files SET health_issues=${sql.json([raw[0], { ...raw[0], detected_at: '2026-10-27' }])} WHERE id=${fileId}`;
        expect((await previewFileHealthReview(sql, fileId)).findings).toHaveLength(1);
        await confirm();
        const [current] =
            await sql`SELECT * FROM media_file_health_reviews WHERE file_id=${fileId}`;
        for (let i = 0; i < 51; i++)
            await sql`INSERT INTO media_file_health_reviews(file_id,issue_type,issue_key,source_generation,stream_signature,assessment_signature,source_snapshot,raw_issue,assessment_snapshot,reason,evidence,decided_by,revoked_at,revoked_by)
          SELECT file_id,issue_type,issue_key,source_generation,stream_signature,assessment_signature,source_snapshot,raw_issue,assessment_snapshot,reason,evidence,decided_by,now(),'test' FROM media_file_health_reviews WHERE id=${current.id}`;
        expect(
            (await previewFileHealthReview(sql, fileId)).history.some(
                (h) => h.id === current.id && h.state === 'current',
            ),
        ).toBe(true);
    });
    it.each(['source', 'stream', 'assessment', 'finding', 'revoked'] as const)(
        'hides accepted duration events in the board and failure list, reopening on %s changes',
        async (kind) => {
            const count = async (): Promise<number> =>
                (await countUnresolvedFailuresByPlugin(sql)).find(
                    (r) => r.pluginId === 'media-probe',
                )?.count ?? 0;
            const list = () =>
                buildTaskFailuresList(
                    sql,
                    'media-probe',
                    { limit: 200, cursorId: null },
                    unrestrictedAccess(),
                );
            const baseline = await count();
            await sql`INSERT INTO plugin_failure_events(plugin_id,item_id,reason)
                VALUES ('media-probe',${fileId},'truncated_video')`;
            expect(await count()).toBe(baseline + 1);
            expect((await list()).failures.some((f) => f.itemId === fileId)).toBe(true);
            await confirm();
            expect(await count()).toBe(baseline);
            expect((await list()).total).toBe(baseline);
            expect((await list()).failures.some((f) => f.itemId === fileId)).toBe(false);
            // A review suppresses only duration events, only for media-probe.
            await sql`INSERT INTO plugin_failure_events(plugin_id,item_id,reason)
                VALUES ('media-probe',${fileId},'decoder_failed'), ('test_plugin_review',${fileId},'truncated_video')`;
            expect(await count()).toBe(baseline + 1);
            expect((await list()).failures.find((f) => f.itemId === fileId)?.reason).toBe(
                'decoder_failed',
            );
            expect(
                (await countUnresolvedFailuresByPlugin(sql)).find(
                    (r) => r.pluginId === 'test_plugin_review',
                )?.count,
            ).toBe(1);
            await sql`DELETE FROM plugin_failure_events WHERE item_id=${fileId} AND reason='decoder_failed'`;
            if (kind === 'source')
                await sql`UPDATE media_files SET file_size_bytes=123 WHERE id=${fileId}`;
            if (kind === 'stream')
                await sql`INSERT INTO media_streams(file_id,stream_index,stream_type,codec) VALUES (${fileId},0,'audio','aac')`;
            if (kind === 'assessment')
                await sql`UPDATE media_files SET health_tail_assessment=jsonb_set(health_tail_assessment,'{observation}','"audible"') WHERE id=${fileId}`;
            if (kind === 'finding')
                await sql`UPDATE media_files SET health_issues=${sql.json([{ ...raw[0], actual_duration: 99 }])} WHERE id=${fileId}`;
            if (kind === 'revoked') {
                const p = await previewFileHealthReview(sql, fileId);
                await writeFileHealthReview(
                    sql,
                    { action: 'revoke', fileId, reviewId: p.history[0].id },
                    'test-admin',
                );
            }
            expect(await count()).toBe(baseline + 1);
            expect((await list()).failures.some((f) => f.itemId === fileId)).toBe(true);
            expect(await getFailureTimeline(sql, 'media-probe', fileId, 10)).toHaveLength(1);
            const [event] =
                await sql`SELECT resolved_at FROM plugin_failure_events WHERE plugin_id='media-probe' AND item_id=${fileId}`;
            expect(event.resolved_at).toBeNull();
        },
    );
    it('aligns probe backlog, failed items and duration patterns without erasing historical events', async () => {
        const [media] =
            await sql`INSERT INTO media_items(title,media_type) VALUES ('Duration review fixture','movie') RETURNING id`;
        await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES (${fileId},${media.id},true)`;
        await sql`UPDATE media_files SET probed_at=now(),keyframes='[]'::jsonb WHERE id=${fileId}`;
        const existingPatterns = (
            await listItemFailureRows(sql, { taskId: 'media-probe', sinceHours: 24 })
        ).filter((row) => row.message === 'truncated_video').length;
        await sql`INSERT INTO plugin_failure_events(plugin_id,item_id,reason) VALUES ('media-probe',${fileId},'truncated_video')`;
        const ctx = {
            sql,
            logger: { debug() {}, info() {}, warn() {}, error() {} },
            signal: new AbortController().signal,
            input: {},
            runId: 'review-test',
        } as unknown as TaskContext<{ [x: string]: unknown; fileId?: string }>;
        const before = await listFailedItems(ctx, { limit: 100, offset: 0 });
        expect(before.items.some((item) => item.id === fileId)).toBe(true);
        const stagesBefore = await mediaProbeTask.backlog!.stages!(ctx);
        assessment.source = {
            ...(await getHealthSourceSnapshot(sql, fileId))!,
            physical: assessment.source.physical,
        };
        await sql`UPDATE media_files SET health_tail_assessment=${sql.json(assessment as unknown as postgres.JSONValue)} WHERE id=${fileId}`;
        expect((await previewFileHealthReview(sql, fileId)).blockedReason).toBeUndefined();
        await confirm();
        expect(
            (await listFailedItems(ctx, { limit: 100, offset: 0 })).items.some(
                (item) => item.id === fileId,
            ),
        ).toBe(false);
        const stagesAfter = await mediaProbeTask.backlog!.stages!(ctx);
        expect(JSON.stringify(stagesAfter)).not.toBe(JSON.stringify(stagesBefore));
        expect(
            (await listItemFailureRows(sql, { taskId: 'media-probe', sinceHours: 24 })).filter(
                (row) => row.message === 'truncated_video',
            ),
        ).toHaveLength(existingPatterns);
        const [event] =
            await sql`SELECT resolved_at FROM plugin_failure_events WHERE item_id=${fileId}`;
        expect(event.resolved_at).toBeNull();
        const p = await previewFileHealthReview(sql, fileId);
        await writeFileHealthReview(
            sql,
            { action: 'revoke', fileId, reviewId: p.history[0].id },
            'test-admin',
        );
        expect(
            (await listFailedItems(ctx, { limit: 100, offset: 0 })).items.some(
                (item) => item.id === fileId,
            ),
        ).toBe(true);
        expect(
            (await listItemFailureRows(sql, { taskId: 'media-probe', sinceHours: 24 })).filter(
                (row) => row.message === 'truncated_video',
            ),
        ).toHaveLength(existingPatterns + 1);
        await sql`DELETE FROM plugin_failure_events WHERE item_id=${fileId}`;
        await sql`DELETE FROM media_items WHERE id=${media.id}`;
    });

    it.each([
        { ...raw[0], basis: 'future_failure_basis' },
        { ...raw[0], expected_duration: '120' },
        { type: 'truncated_video' },
    ])('blocks unsupported raw finding %j', async (issue) => {
        await sql`UPDATE media_files SET health_issues=${sql.json([issue])} WHERE id=${fileId}`;
        expect((await previewFileHealthReview(sql, fileId)).blockedReason).toBe(
            'unsupported-evidence',
        );
    });
    it('live preview rejects replaced bytes; a new recorded generation reopens shared SQL counts', async () => {
        await confirm();
        await writeFile(path, 'changed physical contents');
        const p = await previewFileHealthReview(sql, fileId);
        expect(p.blockedReason).toBe('source-changed');
        expect(p.history[0].state).toBe('outdated');
        // Counts use the latest scanner-recorded generation, rather than opening every file during a SQL read.
        await sql`UPDATE media_files SET file_size_bytes=42 WHERE id=${fileId}`;
        expect(
            (await getFileHealthPage(sql, { scope: 'actionable' })).files.some(
                (file) => file.file_id === fileId,
            ),
        ).toBe(true);
    });
    it('bounds oversized raw evidence before transporting finding objects', async () => {
        await sql`UPDATE media_files SET health_issues=${sql.json([{ ...raw[0], detail: 'x'.repeat(70000) }])} WHERE id=${fileId}`;
        const p = await previewFileHealthReview(sql, fileId);
        expect(p.eligible).toBe(false);
        expect(p.findings).toHaveLength(0);
        expect(JSON.stringify(p).length).toBeLessThan(10000);
    });
});
