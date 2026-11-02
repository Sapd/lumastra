// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { truncateAllTestTables } from '../../../../tests/integration/helpers/cleanup.js';
import { listAdminAuditFeed } from '$lib/server/database/queries/admin-audit.queries.js';
import {
    archiveQuarantineSnapshot,
    getQuarantineSnapshot,
    listQuarantineDispositionHistory,
    listUnresolvedQuarantineBySeries,
    quarantineWrite,
    writeQuarantineSnapshot,
    countDistinctSeriesWithUnresolvedQuarantine,
} from '$lib/server/database/queries/sync-quarantine.queries.js';
import {
    reevaluateQuarantineBacklog,
    confirmQuarantinedCurrentMatchesForSeries,
} from './episode-reconciliation.service.js';
import {
    hideQuarantineGroup,
    showQuarantineWarningsAgain,
    inspectQuarantineGroup,
    dismissReviewedQuarantine,
} from './quarantine-inspection.service.js';

let sql: postgres.Sql;
beforeAll(() => {
    sql = postgres(getTestDatabaseUrl(), { max: 2 });
});
beforeEach(async () => {
    await truncateAllTestTables(sql);
});
afterAll(async () => {
    await sql.end();
});

async function fixture(
    count = 1,
    retained = 0,
): Promise<{ seriesId: string; fileId: string; ids: string[] }> {
    const [{ id: seriesId }] = await sql<
        { id: string }[]
    >`INSERT INTO media_items (title, media_type, status)
        VALUES ('The Paper Lighthouse', 'tv', 'active') RETURNING id`;
    const [{ id: seasonId }] = await sql<
        { id: string }[]
    >`INSERT INTO media_items (title, media_type, parent_id, season_number, status)
        VALUES ('Season 1', 'season', ${seriesId}, 1, 'active') RETURNING id`;
    const [{ id: fileId }] = await sql<
        { id: string }[]
    >`INSERT INTO media_files (file_path) VALUES (${`/invented/${seriesId}.mkv`}) RETURNING id`;
    const episodes = await sql<
        { id: string; episode_number: number }[]
    >`INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status, title_binding)
        SELECT 'The Paper Crossing', 'episode', ${seasonId}::uuid, 1, n, 'active', CASE WHEN n <= ${retained} THEN 'position' ELSE 'identity' END
        FROM generate_series(1, ${count}) n RETURNING id, episode_number`;
    await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) SELECT ${fileId}::uuid, id, true FROM media_items WHERE parent_id = ${seasonId}`;
    await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
        SELECT id, 'tmdb', (9900000 + episode_number)::text, 'episode' FROM media_items WHERE parent_id = ${seasonId}`;
    const prefix = randomUUID().slice(0, 8);
    const ids: string[] = [];
    for (const e of episodes)
        ids[e.episode_number - 1] =
            `${prefix}-0000-4000-8000-${String(e.episode_number).padStart(12, '0')}`;
    const warnings = episodes.map((e) => ({
        id: ids[e.episode_number - 1],
        external_id: e.id,
        payload: {
            seriesMediaId: seriesId,
            seasonNumber: 1,
            episodeNumber: e.episode_number,
            currentTitle: 'The Paper Crossing',
            proposedTitle: 'The Paper Crossing',
            matchedTmdbEpisodeId: String(9900000 + e.episode_number),
            confidence: 0.8,
        },
    }));
    await sql`INSERT INTO sync_quarantine (id, provider, external_id, media_type, expected_series_id, payload, reason, source)
        SELECT w.id, 'lumastra-reconcile', w.external_id, 'episode', ${seriesId}::uuid, w.payload, 'reconcile-backfill:matched', 'fixture'
        FROM jsonb_to_recordset(${sql.json(warnings as never)}::jsonb) w(id uuid, external_id text, payload jsonb)`;
    return { seriesId, fileId, ids };
}

async function noProposal(id: string): Promise<void> {
    await sql`UPDATE sync_quarantine SET reason = 'reconcile-backfill:below-threshold',
        payload = payload || '{"proposedTitle":null,"matchedTmdbEpisodeId":null,"confidence":0}'::jsonb WHERE id = ${id}`;
}

describe('recoverable warning dispositions', () => {
    it('archives explicit historical no-proposal noise without provider calls and preserves raw evidence', async () => {
        const { ids } = await fixture();
        await noProposal(ids[0]);
        const before = await getQuarantineSnapshot(sql, ids[0]);
        const result = await reevaluateQuarantineBacklog(sql, { warningOnly: true });
        expect(result.failedSeries).toBe(0);
        const after = await getQuarantineSnapshot(sql, ids[0]);
        expect(after?.resolvedAt).toBeInstanceOf(Date);
        expect(after?.payload).toEqual(before?.payload);
        expect(after?.reason).toBe(before?.reason);
        const { items } = await listQuarantineDispositionHistory(sql);
        expect(items).toMatchObject([{ kind: 'no-proposal', count: 1, restorable: 1 }]);
        expect(await listUnresolvedQuarantineBySeries(sql)).toEqual([]);
        expect(await countDistinctSeriesWithUnresolvedQuarantine(sql)).toBe(0);
        expect(await showQuarantineWarningsAgain(sql, items[0].batchId, 'admin')).toEqual({
            restored: 1,
            changed: 0,
        });
        await reevaluateQuarantineBacklog(sql, { warningOnly: true });
        expect((await getQuarantineSnapshot(sql, ids[0]))?.resolvedAt).toBeNull();
    });

    it.each([
        'collision',
        'wrong-provider',
        'malformed',
        'locked',
        'missing-file',
        'deleted-link',
        'changed-position',
    ])('retains %s rather than treating it as historical noise', async (kind) => {
        const { ids, fileId } = await fixture();
        await noProposal(ids[0]);
        const entry = (await getQuarantineSnapshot(sql, ids[0]))!;
        if (kind === 'collision')
            await sql`UPDATE sync_quarantine SET reason = 'reconcile-backfill:duplicate-match' WHERE id = ${ids[0]}`;
        if (kind === 'wrong-provider')
            await sql`UPDATE sync_quarantine SET provider = 'other-sync' WHERE id = ${ids[0]}`;
        if (kind === 'malformed')
            await sql`UPDATE sync_quarantine SET payload = '{}'::jsonb WHERE id = ${ids[0]}`;
        if (kind === 'locked')
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${entry.externalId}`;
        if (kind === 'missing-file')
            await sql`UPDATE media_files SET is_missing = TRUE WHERE id = ${fileId}`;
        if (kind === 'deleted-link')
            await sql`DELETE FROM media_file_items WHERE file_id = ${fileId}`;
        if (kind === 'changed-position')
            await sql`UPDATE media_items SET episode_number = 9 WHERE id = ${entry.externalId}`;
        await reevaluateQuarantineBacklog(sql, { warningOnly: true });
        expect((await getQuarantineSnapshot(sql, ids[0]))?.resolvedAt).toBeNull();
        if (kind === 'collision' || kind === 'wrong-provider')
            expect(await countDistinctSeriesWithUnresolvedQuarantine(sql)).toBe(1);
    });

    it.each(['missing-file', 'deleted-link'])(
        'keeps a completed proposal open with a %s',
        async (kind) => {
            const { ids, fileId } = await fixture();
            if (kind === 'missing-file')
                await sql`UPDATE media_files SET is_missing = TRUE WHERE id = ${fileId}`;
            else await sql`DELETE FROM media_file_items WHERE file_id = ${fileId}`;
            const result = await reevaluateQuarantineBacklog(sql, { warningOnly: true });
            expect(result.reattached).toBe(0);
            expect((await getQuarantineSnapshot(sql, ids[0]))?.resolvedAt).toBeNull();
            expect((await listQuarantineDispositionHistory(sql)).items).toEqual([]);
        },
    );

    it('groups gone episodes from one pass into one recoverable history batch', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            ids.push(
                await quarantineWrite(sql, {
                    provider: 'lumastra-reconcile',
                    externalId: randomUUID(),
                    mediaType: 'episode',
                    reason: 'reconcile-backfill:below-threshold',
                    source: 'fixture',
                    payload: {},
                }),
            );
        }
        expect(await reevaluateQuarantineBacklog(sql)).toMatchObject({
            dismissedGone: 3,
            seriesRevisited: 0,
        });
        const { items } = await listQuarantineDispositionHistory(sql);
        expect(items).toMatchObject([{ kind: 'gone', count: 3, restorable: 3 }]);
        expect(items).toHaveLength(1);
        expect(await showQuarantineWarningsAgain(sql, items[0].batchId, 'admin')).toEqual({
            restored: 3,
            changed: 0,
        });
        for (const id of ids) expect((await getQuarantineSnapshot(sql, id))?.resolvedAt).toBeNull();
    });

    it('audits individual and group hides with the actor and original receipt batch', async () => {
        const { seriesId, ids } = await fixture(3);
        const inspection = await inspectQuarantineGroup(sql, seriesId);
        expect(
            await dismissReviewedQuarantine(
                sql,
                ids[0],
                inspection.items.find((entry) => entry.id === ids[0])!.fingerprint,
                'warning-admin',
            ),
        ).toBe(true);
        const individualBatch = (await listQuarantineDispositionHistory(sql)).items[0].batchId;
        const group = (await listUnresolvedQuarantineBySeries(sql))[0];
        const hidden = (await hideQuarantineGroup(sql, seriesId, group.fingerprint, 'group-admin'))!;
        expect(hidden.resolved).toBe(2);
        const { events } = await listAdminAuditFeed(sql, {
            actions: ['hide_quarantine_warning', 'hide_quarantine_group'],
            limit: 10,
        });
        expect(events).toMatchObject([
            {
                actor: 'group-admin',
                action: 'hide_quarantine_group',
                target: hidden.batchId,
                outcome: 'ok',
                detail: { group: seriesId, resolved: 2 },
            },
            {
                actor: 'warning-admin',
                action: 'hide_quarantine_warning',
                target: ids[0],
                outcome: 'ok',
                detail: { batchId: individualBatch },
            },
        ]);
        expect(events).toHaveLength(2);
    });

    it('drains >1,000 retained-first-page warnings by immutable cursor without resolving unseen or position-bound decisions', async () => {
        const { ids } = await fixture(1205, 1000);
        const first = await reevaluateQuarantineBacklog(sql, { cap: 1000, warningOnly: true });
        expect(first).toMatchObject({
            rowsExamined: 1000,
            reattached: 0,
            continuation: ids[999],
            failedSeries: 0,
        });
        expect((await getQuarantineSnapshot(sql, ids[1000]))?.resolvedAt).toBeNull();
        const second = await reevaluateQuarantineBacklog(sql, {
            cap: 1000,
            after: first.continuation,
            warningOnly: true,
        });
        expect(second).toMatchObject({ rowsExamined: 205, reattached: 205, failedSeries: 0 });
        expect(second.continuation).toBeUndefined();
        expect((await getQuarantineSnapshot(sql, ids[0]))?.resolvedAt).toBeNull();
        expect((await getQuarantineSnapshot(sql, ids[1204]))?.resolvedAt).toBeInstanceOf(Date);
    });

    it('traverses >250 removals without skipping a later no-proposal warning', async () => {
        const { ids } = await fixture(275);
        await noProposal(ids[274]);
        const first = await reevaluateQuarantineBacklog(sql, { cap: 250, warningOnly: true });
        expect(first.reattached).toBe(250);
        const second = await reevaluateQuarantineBacklog(sql, {
            cap: 250,
            after: first.continuation,
            warningOnly: true,
        });
        expect(second.rowsExamined).toBe(25);
        expect((await getQuarantineSnapshot(sql, ids[274]))?.resolvedAt).toBeInstanceOf(Date);
    });

    it('refuses stale individual hide and stale group snapshots, including same-value rewrites', async () => {
        const auditBefore = await listAdminAuditFeed(sql, { limit: 10 });
        const { seriesId, ids } = await fixture(2);
        const group = (await listUnresolvedQuarantineBySeries(sql))[0];
        const inspection = await inspectQuarantineGroup(sql, seriesId);
        await sql`UPDATE sync_quarantine SET source = source WHERE id = ${ids[0]}`;
        expect(
            await dismissReviewedQuarantine(
                sql,
                ids[0],
                inspection.items.find((e) => e.id === ids[0])!.fingerprint,
                'admin',
            ),
        ).toBe(false);
        expect(await hideQuarantineGroup(sql, seriesId, group.fingerprint, 'admin')).toBeNull();
        expect((await getQuarantineSnapshot(sql, ids[1]))?.resolvedAt).toBeNull();
        expect((await listQuarantineDispositionHistory(sql)).items).toEqual([]);
        expect(await listAdminAuditFeed(sql, { limit: 10 })).toEqual(auditBefore);
    });

    it('restores only the original >1,000 row batch; refuses changed/revived warnings and is idempotent', async () => {
        const { seriesId, ids } = await fixture(1005);
        const group = (await listUnresolvedQuarantineBySeries(sql))[0];
        const hidden = (await hideQuarantineGroup(sql, seriesId, group.fingerprint, 'admin'))!;
        expect(hidden.resolved).toBe(1005);
        const original = (await getQuarantineSnapshot(sql, ids[0]))!;
        // A real same-row revival invalidates the original receipt even if payload values repeat.
        await sql`UPDATE sync_quarantine SET resolved_at = NULL, resolved_by = NULL, resolution = NULL WHERE id = ${original.id}`;
        await sql`UPDATE sync_quarantine SET source = source WHERE id = ${ids[1]}`;
        const unrelated = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'new-incident',
            mediaType: 'episode',
            expectedSeriesId: seriesId,
            payload: {},
            reason: 'real conflict',
            source: 'fixture',
        });
        const first = await showQuarantineWarningsAgain(sql, hidden.batchId, 'admin');
        expect(first).toMatchObject({ restored: 998, changed: 2, continuation: ids[999] });
        expect(
            await showQuarantineWarningsAgain(sql, hidden.batchId, 'admin', first.continuation),
        ).toEqual({
            restored: 5,
            changed: 0,
        });
        expect((await getQuarantineSnapshot(sql, unrelated))?.resolvedAt).toBeNull();
        expect((await getQuarantineSnapshot(sql, ids[1]))?.resolvedAt).toBeInstanceOf(Date);
        expect((await getQuarantineSnapshot(sql, ids[1004]))?.payload).toMatchObject({
            proposedTitle: 'The Paper Crossing',
        });
        expect(await showQuarantineWarningsAgain(sql, hidden.batchId, 'admin')).toEqual({
            restored: 0,
            changed: 2,
        });
    });

    it('does not recreate unchanged hidden warnings on repeated backfill writes, but reopens changed proposals', async () => {
        const { seriesId, ids } = await fixture();
        const group = (await listUnresolvedQuarantineBySeries(sql))[0];
        await hideQuarantineGroup(sql, seriesId, group.fingerprint, 'admin');
        const previous = (await getQuarantineSnapshot(sql, ids[0]))!;
        const write = {
            provider: previous.provider,
            externalId: previous.externalId,
            mediaType: previous.mediaType,
            expectedSeriesId: seriesId,
            payload: previous.payload,
            reason: previous.reason,
            source: 'next-cycle',
        };
        expect(await writeQuarantineSnapshot(sql, write, previous)).toBe('hidden');
        expect(await writeQuarantineSnapshot(sql, write, previous)).toBe('hidden');
        expect((await getQuarantineSnapshot(sql, ids[0]))?.resolvedAt).toBeInstanceOf(Date);
        expect(
            await writeQuarantineSnapshot(
                sql,
                { ...write, payload: { ...write.payload, proposedTitle: 'A New Paper Crossing' } },
                previous,
            ),
        ).toBe(true);
        expect((await getQuarantineSnapshot(sql, ids[0]))?.resolvedAt).toBeNull();
    });

    it('keeps unchanged generic sync warnings hidden and reopens genuinely changed warnings', async () => {
        const entry = {
            provider: 'jellyfin',
            externalId: 'invented-provider-episode',
            mediaType: 'episode',
            payload: { mismatch: 'A' },
            reason: 'parent conflict',
            source: 'fixture',
        };
        const id = await quarantineWrite(sql, entry);
        const snapshot = (await getQuarantineSnapshot(sql, id))!;
        await archiveQuarantineSnapshot(sql, snapshot, 'admin', 'hidden');
        expect(await quarantineWrite(sql, entry)).toBe(id);
        expect((await getQuarantineSnapshot(sql, id))?.resolvedAt).toBeInstanceOf(Date);
        await quarantineWrite(sql, { ...entry, payload: { mismatch: 'B' } });
        expect((await getQuarantineSnapshot(sql, id))?.resolvedAt).toBeNull();
        const [receipt] =
            await sql`SELECT previous_version, previous_warning FROM quarantine_dispositions WHERE warning_id = ${id}`;
        expect(receipt.previous_version).toBe(snapshot.rowVersion);
        expect(receipt.previous_warning).toEqual(snapshot.rowImage);
        expect(receipt.previous_warning.payload).toEqual({ mismatch: 'A' });
    });

    it('restores only the selected current-match warnings without upgrading position binding', async () => {
        const { seriesId, ids } = await fixture(2, 2);
        const preview = await confirmQuarantinedCurrentMatchesForSeries(sql, seriesId, 'admin', {
            preview: true,
        });
        const selected = preview.review!.find((r) => r.id === ids[0])!;
        expect(selected.eligible).toBe(true);
        const result = await confirmQuarantinedCurrentMatchesForSeries(sql, seriesId, 'admin', {
            preview: false,
            reviewedPage: preview.reviewedPage,
            reviewed: [{ id: selected.id, fingerprint: selected.fingerprint }],
        });
        expect(result.resolved).toBe(1);
        expect((await getQuarantineSnapshot(sql, ids[1]))?.resolvedAt).toBeNull();
        const { items } = await listQuarantineDispositionHistory(sql);
        expect(items).toMatchObject([{ kind: 'hidden', count: 1, restorable: 1 }]);
        expect(await showQuarantineWarningsAgain(sql, items[0].batchId, 'admin')).toEqual({
            restored: 1,
            changed: 0,
        });
        const [bindings] =
            await sql`SELECT COUNT(*)::int AS count FROM media_items WHERE media_type = 'episode' AND title_binding = 'position'`;
        expect(bindings.count).toBe(2);
        expect((await getQuarantineSnapshot(sql, ids[0]))?.resolvedAt).toBeNull();
    });

    it('restores exact previous resolution fields even for a legacy inconsistent unresolved row', async () => {
        const { seriesId, ids } = await fixture();
        await sql`UPDATE sync_quarantine SET resolved_by = 'legacy-actor', resolution = 'dismissed' WHERE id = ${ids[0]}`;
        const before = (await getQuarantineSnapshot(sql, ids[0]))!;
        const group = (await listUnresolvedQuarantineBySeries(sql))[0];
        const batch = (await hideQuarantineGroup(sql, seriesId, group.fingerprint, 'admin'))!;
        await showQuarantineWarningsAgain(sql, batch.batchId, 'admin');
        expect((await getQuarantineSnapshot(sql, ids[0]))?.rowImage).toEqual(before.rowImage);
    });

    it('cannot mint a receipt from a stale snapshot, and cancellation makes no changes', async () => {
        const { ids } = await fixture();
        const snapshot = (await getQuarantineSnapshot(sql, ids[0]))!;
        await sql`UPDATE sync_quarantine SET source = source WHERE id = ${ids[0]}`;
        expect(await archiveQuarantineSnapshot(sql, snapshot, 'admin', 'hidden')).toBe(false);
        const controller = new AbortController();
        controller.abort();
        await reevaluateQuarantineBacklog(sql, { warningOnly: true, signal: controller.signal });
        expect((await getQuarantineSnapshot(sql, ids[0]))?.resolvedAt).toBeNull();
    });
});
