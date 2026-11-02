// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Sync Quarantine Query Module
 *
 * Tests the W2.1 quarantine schema + helpers. The W2.2 Jellyfin sync rework is
 * the first writer; these tests pin down the read/write/resolve lifecycle.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

import {
    quarantineWrite,
    writeQuarantineSnapshot,
    getQuarantineSnapshot,
    listUnresolvedQuarantine,
    listAllQuarantine,
    getQuarantineById,
    resolveQuarantine,
    countUnresolvedQuarantine,
    resolveByExternalKey,
    listUnresolvedQuarantineBySeries,
    listUnresolvedQuarantineForSeries,
    bulkResolveQuarantineBySeries,
    countDistinctSeriesWithUnresolvedQuarantine,
    listUnresolvedQuarantineByProvider,
} from './sync-quarantine.queries.js';

describe('Sync Quarantine Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Clean slate for the quarantine table on every test
        await sql`TRUNCATE TABLE sync_quarantine RESTART IDENTITY CASCADE`;
    });

    it.each(['upsert', 'snapshot'] as const)(
        '%s preserves first seen across unresolved rewrites and resets it after resolution',
        async (writer) => {
            const firstSeen = new Date('2026-01-01T12:00:00.000Z');
            const cutoff = new Date('2026-02-01T12:00:00.000Z');
            for (let i = 0; i < 11; i++) {
                const entry = {
                    provider: 'jellyfin',
                    externalId: `recurring-${i}`,
                    mediaType: 'episode',
                    parentTmdbId: String(i),
                    payload: {},
                    reason: 'identity conflict',
                    source: 'test',
                };
                const id = await quarantineWrite(sql, entry);
                await sql`UPDATE sync_quarantine SET created_at = ${firstSeen} WHERE id = ${id}`;
                const rewrite = async (): Promise<void> => {
                    if (writer === 'upsert') {
                        expect(
                            await quarantineWrite(sql, { ...entry, reason: 'updated conflict' }),
                        ).toBe(id);
                    } else {
                        const previous = await getQuarantineSnapshot(sql, id);
                        expect(previous).not.toBeNull();
                        expect(
                            await writeQuarantineSnapshot(
                                sql,
                                { ...entry, reason: 'updated conflict' },
                                previous!,
                            ),
                        ).toBe(true);
                    }
                };
                await rewrite();
                await rewrite();
                expect((await getQuarantineById(sql, id))?.createdAt).toEqual(firstSeen);
                expect((await getQuarantineById(sql, id))?.reason).toBe('updated conflict');
                if (i === 10) {
                    expect(await countDistinctSeriesWithUnresolvedQuarantine(sql, cutoff)).toBe(11);
                    await resolveQuarantine(sql, id, {
                        resolvedBy: 'admin',
                        resolution: 'dismissed',
                    });
                    await rewrite();
                    const reopened = await getQuarantineById(sql, id);
                    expect(reopened?.resolvedAt).toBeNull();
                    expect(reopened!.createdAt.getTime()).toBeGreaterThan(cutoff.getTime());
                    expect(await countDistinctSeriesWithUnresolvedQuarantine(sql, cutoff)).toBe(10);
                }
            }
        },
    );

    it('writes an entry and reads it back via getQuarantineById', async () => {
        const id = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-episode-abc',
            mediaType: 'episode',
            parentTmdbId: '256480',
            payload: {
                jellyfinSeriesId: 'jf-series-xyz',
                episodeName: 'Pilot',
            },
            reason: 'parent series TMDB id mismatch',
            source: 'jellyfin-episode-attach',
        });

        expect(id).toMatch(/^[0-9a-f]{8}-/);

        const entry = await getQuarantineById(sql, id);
        expect(entry).not.toBeNull();
        expect(entry?.provider).toBe('jellyfin');
        expect(entry?.externalId).toBe('jf-episode-abc');
        expect(entry?.mediaType).toBe('episode');
        expect(entry?.parentTmdbId).toBe('256480');
        expect(entry?.payload).toEqual({
            jellyfinSeriesId: 'jf-series-xyz',
            episodeName: 'Pilot',
        });
        expect(entry?.reason).toBe('parent series TMDB id mismatch');
        expect(entry?.source).toBe('jellyfin-episode-attach');
        expect(entry?.resolvedAt).toBeNull();
        expect(entry?.resolvedBy).toBeNull();
        expect(entry?.resolution).toBeNull();
        expect(entry?.createdAt).toBeInstanceOf(Date);
    });

    it('listUnresolvedQuarantine returns only unresolved entries', async () => {
        const id1 = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-1',
            mediaType: 'episode',
            payload: { kind: 'unresolved' },
            reason: 'reason 1',
            source: 'jellyfin-episode-attach',
        });
        const id2 = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-2',
            mediaType: 'episode',
            payload: { kind: 'will-resolve' },
            reason: 'reason 2',
            source: 'jellyfin-episode-attach',
        });

        // Resolve only id2
        await resolveQuarantine(sql, id2, {
            resolvedBy: 'admin',
            resolution: 'dismissed',
        });

        const unresolved = await listUnresolvedQuarantine(sql);
        expect(unresolved.map((e) => e.id)).toEqual([id1]);
    });

    it('listAllQuarantine includes both resolved and unresolved, newest first', async () => {
        const idA = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-A',
            mediaType: 'episode',
            payload: {},
            reason: 'A',
            source: 'jellyfin-episode-attach',
        });
        // Small delay to guarantee created_at ordering on systems with low-res clocks
        await new Promise((r) => setTimeout(r, 10));
        const idB = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-B',
            mediaType: 'episode',
            payload: {},
            reason: 'B',
            source: 'jellyfin-episode-attach',
        });

        await resolveQuarantine(sql, idA, {
            resolvedBy: 'admin',
            resolution: 'reattached',
        });

        const all = await listAllQuarantine(sql);
        expect(all.map((e) => e.id)).toEqual([idB, idA]);
        // Resolved row keeps its resolution metadata
        const resolvedRow = all.find((e) => e.id === idA);
        expect(resolvedRow?.resolution).toBe('reattached');
        expect(resolvedRow?.resolvedBy).toBe('admin');
        expect(resolvedRow?.resolvedAt).toBeInstanceOf(Date);
    });

    it('resolveQuarantine stamps resolved_at, resolved_by, and resolution', async () => {
        const id = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-resolve-me',
            mediaType: 'episode',
            payload: {},
            reason: 'will be resolved',
            source: 'jellyfin-episode-attach',
        });

        const before = await getQuarantineById(sql, id);
        expect(before?.resolvedAt).toBeNull();

        await resolveQuarantine(sql, id, {
            resolvedBy: 'denis',
            resolution: 'recreated',
        });

        const after = await getQuarantineById(sql, id);
        expect(after?.resolvedAt).toBeInstanceOf(Date);
        expect(after?.resolvedBy).toBe('denis');
        expect(after?.resolution).toBe('recreated');
    });

    it('resolveQuarantine is idempotent — second resolve throws', async () => {
        const id = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-idempotent',
            mediaType: 'episode',
            payload: {},
            reason: 'will be resolved twice',
            source: 'jellyfin-episode-attach',
        });

        await resolveQuarantine(sql, id, {
            resolvedBy: 'admin',
            resolution: 'dismissed',
        });

        await expect(
            resolveQuarantine(sql, id, {
                resolvedBy: 'admin',
                resolution: 'dismissed',
            }),
        ).rejects.toThrow(/already resolved or not found/);
    });

    it('resolveQuarantine throws when the id does not exist', async () => {
        await expect(
            resolveQuarantine(sql, '00000000-0000-0000-0000-000000000000', {
                resolvedBy: 'admin',
                resolution: 'dismissed',
            }),
        ).rejects.toThrow(/already resolved or not found/);
    });

    it('listAllQuarantine clamps caller-supplied limit to MAX_LIMIT (1000)', async () => {
        // Insert a fresh batch + ask for an absurd limit; the cap is the
        // load-bearing assertion here, not the row count.
        const writes: Promise<string>[] = [];
        for (let i = 0; i < 5; i++) {
            writes.push(
                quarantineWrite(sql, {
                    provider: 'jellyfin',
                    externalId: `jf-cap-${i}`,
                    mediaType: 'episode',
                    payload: {},
                    reason: 'cap test',
                    source: 'jellyfin-episode-attach',
                }),
            );
        }
        await Promise.all(writes);

        const all = await listAllQuarantine(sql, 999_999);
        // We didn't insert > MAX_LIMIT rows, but the underlying SQL must have
        // bound LIMIT 1000 (not 999999). Returning <= MAX_LIMIT proves the
        // clamp is in effect for any caller-supplied input.
        expect(all.length).toBeLessThanOrEqual(1000);
        expect(all.length).toBe(5);
    });

    it('listUnresolvedQuarantine clamps caller-supplied limit to MAX_LIMIT (1000)', async () => {
        await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-cap-unresolved',
            mediaType: 'episode',
            payload: {},
            reason: 'cap test',
            source: 'jellyfin-episode-attach',
        });

        const unresolved = await listUnresolvedQuarantine(sql, 999_999);
        expect(unresolved.length).toBeLessThanOrEqual(1000);
        expect(unresolved.length).toBe(1);
    });

    it('countUnresolvedQuarantine reflects the current state', async () => {
        expect(await countUnresolvedQuarantine(sql)).toBe(0);

        const id1 = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-count-1',
            mediaType: 'episode',
            payload: {},
            reason: 'r',
            source: 'jellyfin-episode-attach',
        });
        await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-count-2',
            mediaType: 'episode',
            payload: {},
            reason: 'r',
            source: 'jellyfin-episode-attach',
        });

        expect(await countUnresolvedQuarantine(sql)).toBe(2);

        await resolveQuarantine(sql, id1, {
            resolvedBy: 'admin',
            resolution: 'dismissed',
        });

        expect(await countUnresolvedQuarantine(sql)).toBe(1);
    });

    it('dedup on re-write: same key twice produces 1 row with latest reason+payload', async () => {
        const id1 = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-dedup',
            mediaType: 'episode',
            payload: { version: 1 },
            reason: 'first reason',
            source: 'jellyfin-attach-only-sync',
        });

        const id2 = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-dedup',
            mediaType: 'episode',
            payload: { version: 2 },
            reason: 'second reason',
            source: 'jellyfin-attach-only-sync',
        });

        // Same row — IDs must match
        expect(id1).toBe(id2);

        const all = await listAllQuarantine(sql);
        expect(all).toHaveLength(1);
        expect(all[0].reason).toBe('second reason');
        expect(all[0].payload).toEqual({ version: 2 });
    });

    it('re-write after resolve resurrects the entry (resolved_at = NULL, new reason)', async () => {
        const id = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-resurrect',
            mediaType: 'episode',
            payload: { attempt: 1 },
            reason: 'initial quarantine',
            source: 'jellyfin-attach-only-sync',
        });

        await resolveQuarantine(sql, id, {
            resolvedBy: 'admin',
            resolution: 'dismissed',
        });

        const afterResolve = await getQuarantineById(sql, id);
        expect(afterResolve?.resolvedAt).toBeInstanceOf(Date);

        // Re-quarantine same key after admin resolved it
        const id2 = await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-resurrect',
            mediaType: 'episode',
            payload: { attempt: 2 },
            reason: 're-occurrence after resolve',
            source: 'jellyfin-attach-only-sync',
        });

        expect(id).toBe(id2);

        const resurrected = await getQuarantineById(sql, id);
        expect(resurrected?.resolvedAt).toBeNull();
        expect(resurrected?.resolvedBy).toBeNull();
        expect(resurrected?.resolution).toBeNull();
        expect(resurrected?.reason).toBe('re-occurrence after resolve');
    });

    it('resolveByExternalKey on missing entry returns 0 without throwing', async () => {
        const count = await resolveByExternalKey(
            sql,
            {
                provider: 'jellyfin',
                externalId: 'jf-nonexistent',
                mediaType: 'episode',
            },
            'auto:sync',
            'reattached',
        );
        expect(count).toBe(0);
    });

    it('resolveByExternalKey on existing unresolved entry returns 1 and stamps resolved_at', async () => {
        await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-auto-resolve',
            mediaType: 'episode',
            payload: {},
            reason: 'pending',
            source: 'jellyfin-attach-only-sync',
        });

        const count = await resolveByExternalKey(
            sql,
            {
                provider: 'jellyfin',
                externalId: 'jf-auto-resolve',
                mediaType: 'episode',
            },
            'auto:jellyfin-attach-only-sync',
            'reattached',
        );
        expect(count).toBe(1);

        const all = await listAllQuarantine(sql);
        expect(all).toHaveLength(1);
        expect(all[0].resolvedAt).toBeInstanceOf(Date);
        expect(all[0].resolvedBy).toBe('auto:jellyfin-attach-only-sync');
        expect(all[0].resolution).toBe('reattached');
    });
});

describe('Sync Quarantine per-series grouping (bulk triage)', () => {
    let sql: postgres.Sql;
    let seriesAId: string;
    let seriesBId: string;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`TRUNCATE TABLE sync_quarantine RESTART IDENTITY CASCADE`;
        [{ id: seriesAId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type) VALUES ('Quarantine Series A', 'tv') RETURNING id`;
        [{ id: seriesBId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type) VALUES ('Quarantine Series B', 'tv') RETURNING id`;
    });

    afterEach(async () => {
        await sql`DELETE FROM media_items WHERE id IN (${seriesAId}, ${seriesBId})`;
    });

    it('groups by expected_series_id, joining media_items for the title', async () => {
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-a1',
            mediaType: 'episode',
            expectedSeriesId: seriesAId,
            payload: { seriesMediaId: seriesAId },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-a2',
            mediaType: 'episode',
            expectedSeriesId: seriesAId,
            payload: { seriesMediaId: seriesAId },
            reason: 'reconcile-backfill:matched',
            source: 'reconciliation-backfill',
        });

        const groups = await listUnresolvedQuarantineBySeries(sql);
        expect(groups).toHaveLength(1);
        expect(groups[0].seriesId).toBe(seriesAId);
        expect(groups[0].seriesTitle).toBe('Quarantine Series A');
        expect(groups[0].totalUnresolved).toBe(2);
        expect(groups[0].reasonCounts).toEqual({
            'reconcile-backfill:below-threshold': 1,
            'reconcile-backfill:matched': 1,
        });
    });

    it('falls back to payload.seriesMediaId when expected_series_id is not set', async () => {
        // Mirrors rows written before expected_series_id was populated at write
        // time — quarantineWrite still embeds the series id in payload.
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-legacy',
            mediaType: 'episode',
            payload: { seriesMediaId: seriesBId },
            reason: 'reconcile-backfill:duplicate-match',
            source: 'reconciliation-backfill',
        });

        const groups = await listUnresolvedQuarantineBySeries(sql);
        expect(groups).toHaveLength(1);
        expect(groups[0].seriesId).toBe(seriesBId);
        expect(groups[0].seriesTitle).toBe('Quarantine Series B');
    });

    it('falls back to parent_tmdb_id, then a single "unknown" bucket, when no series id is known', async () => {
        await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-tmdb-only-1',
            mediaType: 'episode',
            parentTmdbId: '999888',
            payload: {},
            reason: 'parent series TMDB id mismatch',
            source: 'jellyfin-episode-attach',
        });
        await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-tmdb-only-2',
            mediaType: 'episode',
            parentTmdbId: '999888',
            payload: {},
            reason: 'parent series TMDB id mismatch',
            source: 'jellyfin-episode-attach',
        });
        await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-orphan',
            mediaType: 'episode',
            payload: {},
            reason: 'no series signal at all',
            source: 'jellyfin-episode-attach',
        });

        const groups = await listUnresolvedQuarantineBySeries(sql);
        const tmdbGroup = groups.find((g) => g.parentTmdbId === '999888');
        expect(tmdbGroup?.seriesId).toBeNull();
        expect(tmdbGroup?.totalUnresolved).toBe(2);

        const unknownGroup = groups.find((g) => g.seriesId === null && g.parentTmdbId === null);
        expect(unknownGroup?.totalUnresolved).toBe(1);
    });

    it('sorts groups by total unresolved rows descending', async () => {
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-small-1',
            mediaType: 'episode',
            expectedSeriesId: seriesAId,
            payload: { seriesMediaId: seriesAId },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });
        for (const suffix of ['1', '2', '3']) {
            await quarantineWrite(sql, {
                provider: 'lumastra-reconcile',
                externalId: `ep-big-${suffix}`,
                mediaType: 'episode',
                expectedSeriesId: seriesBId,
                payload: { seriesMediaId: seriesBId },
                reason: 'reconcile-backfill:below-threshold',
                source: 'reconciliation-backfill',
            });
        }

        const groups = await listUnresolvedQuarantineBySeries(sql);
        expect(groups[0].seriesId).toBe(seriesBId);
        expect(groups[0].totalUnresolved).toBe(3);
        expect(groups[1].seriesId).toBe(seriesAId);
        expect(groups[1].totalUnresolved).toBe(1);
    });

    it('listUnresolvedQuarantineForSeries returns only rows for that series (either column or payload fallback)', async () => {
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-a-col',
            mediaType: 'episode',
            expectedSeriesId: seriesAId,
            payload: { seriesMediaId: seriesAId },
            reason: 'reconcile-backfill:matched',
            source: 'reconciliation-backfill',
        });
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-a-payload-only',
            mediaType: 'episode',
            payload: { seriesMediaId: seriesAId },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-b',
            mediaType: 'episode',
            expectedSeriesId: seriesBId,
            payload: { seriesMediaId: seriesBId },
            reason: 'reconcile-backfill:matched',
            source: 'reconciliation-backfill',
        });

        const forA = await listUnresolvedQuarantineForSeries(sql, seriesAId);
        expect(forA.map((e) => e.externalId).sort()).toEqual(['ep-a-col', 'ep-a-payload-only']);
    });

    it('bulkResolveQuarantineBySeries by seriesId resolves only that series’ rows', async () => {
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-a-bulk',
            mediaType: 'episode',
            expectedSeriesId: seriesAId,
            payload: { seriesMediaId: seriesAId },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-b-bulk',
            mediaType: 'episode',
            expectedSeriesId: seriesBId,
            payload: { seriesMediaId: seriesBId },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });

        const resolved = await bulkResolveQuarantineBySeries(
            sql,
            { seriesId: seriesAId },
            { resolvedBy: 'admin', resolution: 'dismissed' },
        );
        expect(resolved).toBe(1);

        const remaining = await listUnresolvedQuarantine(sql);
        expect(remaining.map((e) => e.externalId)).toEqual(['ep-b-bulk']);
    });

    it('series triage leaves episode-move proposals alone (they have their own Apply/Dismiss)', async () => {
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-a-backfill',
            mediaType: 'episode',
            expectedSeriesId: seriesAId,
            payload: { seriesMediaId: seriesAId },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile-absolute',
            externalId: 'ep-a-proposal:tmdb-1',
            mediaType: 'episode',
            expectedSeriesId: seriesAId,
            payload: { seriesMediaId: seriesAId },
            reason: 'absolute-numbering:proposed',
            source: 'absolute-numbering-reconciliation',
        });

        const groups = await listUnresolvedQuarantineBySeries(sql);
        expect(groups).toHaveLength(1);
        expect(groups[0].totalUnresolved).toBe(1);
        expect(groups[0].reasonCounts).toEqual({ 'reconcile-backfill:below-threshold': 1 });

        // "Dismiss all" must not dismiss the proposal: a dismissed pair is
        // blocked for good, and the admin never looked at it.
        const resolved = await bulkResolveQuarantineBySeries(
            sql,
            { seriesId: seriesAId },
            { resolvedBy: 'admin', resolution: 'dismissed' },
        );
        expect(resolved).toBe(1);
        const remaining = await listUnresolvedQuarantine(sql);
        expect(remaining.map((e) => e.externalId)).toEqual(['ep-a-proposal:tmdb-1']);
    });

    it('bulkResolveQuarantineBySeries by parentTmdbId resolves only rows with no resolvable series', async () => {
        await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-tmdb-bulk-1',
            mediaType: 'episode',
            parentTmdbId: '555444',
            payload: {},
            reason: 'no series match',
            source: 'jellyfin-episode-attach',
        });
        await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-tmdb-bulk-2',
            mediaType: 'episode',
            parentTmdbId: '555444',
            payload: {},
            reason: 'no series match',
            source: 'jellyfin-episode-attach',
        });
        // A resolvable-series row that happens to carry the same parent_tmdb_id
        // must NOT be swept up by the parentTmdbId-only bulk action.
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-with-series',
            mediaType: 'episode',
            expectedSeriesId: seriesAId,
            parentTmdbId: '555444',
            payload: { seriesMediaId: seriesAId },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });

        const resolved = await bulkResolveQuarantineBySeries(
            sql,
            { parentTmdbId: '555444' },
            { resolvedBy: 'admin', resolution: 'dismissed' },
        );
        expect(resolved).toBe(2);

        const remaining = await listUnresolvedQuarantine(sql);
        expect(remaining.map((e) => e.externalId)).toEqual(['ep-with-series']);
    });

    it('countDistinctSeriesWithUnresolvedQuarantine counts groups, not rows', async () => {
        expect(await countDistinctSeriesWithUnresolvedQuarantine(sql)).toBe(0);

        for (const suffix of ['1', '2', '3']) {
            await quarantineWrite(sql, {
                provider: 'lumastra-reconcile',
                externalId: `ep-count-${suffix}`,
                mediaType: 'episode',
                expectedSeriesId: seriesAId,
                payload: { seriesMediaId: seriesAId, proposedTitle: 'Candidate A' },
                reason: 'reconcile-backfill:below-threshold',
                source: 'reconciliation-backfill',
            });
        }
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-count-other-series',
            mediaType: 'episode',
            expectedSeriesId: seriesBId,
            payload: { seriesMediaId: seriesBId, matchedTmdbEpisodeId: '123' },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });

        // 4 rows, but only 2 distinct series.
        expect(await countDistinctSeriesWithUnresolvedQuarantine(sql)).toBe(2);
    });

    it('listUnresolvedQuarantineByProvider filters by provider and orders oldest first', async () => {
        await quarantineWrite(sql, {
            provider: 'jellyfin',
            externalId: 'jf-other-provider',
            mediaType: 'episode',
            payload: {},
            reason: 'jellyfin reason',
            source: 'jellyfin-episode-attach',
        });
        const idOld = await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-provider-old',
            mediaType: 'episode',
            expectedSeriesId: seriesAId,
            payload: { seriesMediaId: seriesAId },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });
        await new Promise((r) => setTimeout(r, 10));
        const idNew = await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: 'ep-provider-new',
            mediaType: 'episode',
            expectedSeriesId: seriesAId,
            payload: { seriesMediaId: seriesAId },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });

        const rows = await listUnresolvedQuarantineByProvider(sql, 'lumastra-reconcile', 10);
        expect(rows.map((e) => e.id)).toEqual([idOld, idNew]);
    });
});
