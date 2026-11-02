// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Saving a missing provider key must make the rows the stage's global guard
 * parked eligible at once (not after the 6h/12h retry window) and start the
 * tasks. Asserted at the seam the drain reads: the mdblist-sync candidate
 * query, which skips rows whose next_eligible_at lies in the future.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';

const { startRun } = vi.hoisted(() => ({ startRun: vi.fn() }));
vi.mock('./orchestrator.js', () => ({ orchestrator: { startRun } }));

import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    markAllPendingSkippedTransientForStage,
    markSkippedTransientBatch,
} from '../database/queries/stage-state.queries.js';
import { findEmbeddingCoverageTableBacklog } from '../database/queries/embeddings.queries.js';
import {
    releaseAfterProviderKeySaved,
    MDBLIST_KEY_RELEASE,
    LASTFM_KEY_RELEASE,
} from './provider-key-release.js';
import { musicPopularityTask } from './builtin/native/music-popularity.js';
import { artistEnrichmentTask } from './builtin/native/artist-enrichment.js';
import { albumEnrichmentTask } from './builtin/native/album-enrichment.js';
import { buildAdminContextStub } from './plugin-context.js';
import { PluginSecrets } from './secrets.js';

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

describe('provider key saved → parked rows released, tasks started', () => {
    let sql: postgres.Sql;
    const items: string[] = [];

    async function item(mediaType: string, stageId: string): Promise<string> {
        const id = crypto.randomUUID();
        items.push(id);
        await sql`
            INSERT INTO media_items (id, media_type, title)
            VALUES (${id}::uuid, ${mediaType}, ${'Test key-release ' + id.slice(0, 6)})
        `;
        await sql`
            INSERT INTO media_item_stage_state (media_item_id, stage_id, status, processing_version)
            VALUES (${id}::uuid, ${stageId}, 'pending', 1)
        `;
        return id;
    }

    async function backlogIds(stageId: string): Promise<string[]> {
        const rows = await findEmbeddingCoverageTableBacklog(sql, stageId, 1000);
        return rows.map((r) => r.id).filter((id) => items.includes(id));
    }

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        if (items.length) {
            await sql`DELETE FROM media_item_stage_state WHERE media_item_id = ANY(${items}::uuid[])`;
            await sql`DELETE FROM media_items WHERE id = ANY(${items}::uuid[])`;
        }
        await sql`DELETE FROM plugin_secrets WHERE plugin_id = 'music-popularity' AND key = 'LASTFM_API_KEY'`;
        await closeTestDb();
    });
    beforeEach(async () => {
        startRun.mockReset().mockResolvedValue({ runId: 'r1' });
        if (items.length) {
            await sql`DELETE FROM media_item_stage_state WHERE media_item_id = ANY(${items}::uuid[])`;
            await sql`DELETE FROM media_items WHERE id = ANY(${items}::uuid[])`;
            items.length = 0;
        }
        await sql`DELETE FROM plugin_secrets WHERE plugin_id = 'music-popularity' AND key = 'LASTFM_API_KEY'`;
    });

    it('MDBList: guard-parked rows become drain candidates now; other parked rows keep their window', async () => {
        const parked = await item('movie', 'mdblist-sync');
        const locked = await item('movie', 'mdblist-sync');
        // The metadata-locked rule parks first, then the global guard parks the rest.
        await markSkippedTransientBatch(sql, {
            stageId: 'mdblist-sync',
            mediaItemIds: [locked],
            skippedReason: 'metadata-locked',
            retryAfterMs: TWELVE_HOURS,
        });
        await markAllPendingSkippedTransientForStage(sql, {
            stageId: 'mdblist-sync',
            skippedReason: MDBLIST_KEY_RELEASE.skippedReason,
            retryAfterMs: TWELVE_HOURS,
        });
        expect(await backlogIds('mdblist-sync')).toEqual([]);

        const out = await releaseAfterProviderKeySaved(sql, MDBLIST_KEY_RELEASE);

        expect(out.released).toBeGreaterThanOrEqual(1);
        expect(await backlogIds('mdblist-sync')).toEqual([parked]);
        expect(startRun.mock.calls.map((c) => c[0])).toEqual([
            'mdblist-sync',
            'curated-lists-sync',
        ]);
    });

    it('Last.fm: the music-popularity settings hook releases parked artists once the key is stored', async () => {
        const artist = await item('artist', 'music-popularity');
        await markAllPendingSkippedTransientForStage(sql, {
            stageId: 'music-popularity',
            skippedReason: LASTFM_KEY_RELEASE.skippedReason,
            retryAfterMs: 6 * 60 * 60 * 1000,
        });
        const onConfigChange = musicPopularityTask.lifecycle!.onConfigChange!;
        const ctx = { sql } as unknown as Parameters<typeof onConfigChange>[0];

        // A settings save without the key (or the key deleted) changes nothing.
        await onConfigChange(ctx, {});
        expect(await backlogIds('music-popularity')).toEqual([]);
        expect(startRun).not.toHaveBeenCalled();

        await sql`
            INSERT INTO plugin_secrets (plugin_id, key, value_encrypted)
            VALUES ('music-popularity', 'LASTFM_API_KEY', ${Buffer.from([0])})
        `;
        await onConfigChange(ctx, {});
        expect(await backlogIds('music-popularity')).toEqual([artist]);
        expect(startRun).toHaveBeenCalledTimes(1);
        expect(startRun.mock.calls[0]![0]).toBe('music-popularity');

        // Re-saving an unrelated setting later: nothing parked, no new run.
        startRun.mockClear();
        await onConfigChange(ctx, {});
        expect(startRun).not.toHaveBeenCalled();
    });

    it.each([artistEnrichmentTask, albumEnrichmentTask])(
        'Discogs: $id settings hook releases only missing-source rows immediately and safely re-runs',
        async (task) => {
            const stageId = task.id;
            const parked = await item(
                stageId === 'artist-enrichment' ? 'artist' : 'album',
                stageId,
            );
            const locked = await item(
                stageId === 'artist-enrichment' ? 'artist' : 'album',
                stageId,
            );
            await markSkippedTransientBatch(sql, {
                stageId,
                mediaItemIds: [locked],
                skippedReason: 'metadata-locked',
                retryAfterMs: TWELVE_HOURS,
            });
            await markAllPendingSkippedTransientForStage(sql, {
                stageId,
                skippedReason: 'no-usable-enrichment-source',
                retryAfterMs: TWELVE_HOURS,
            });
            const ctx = buildAdminContextStub(stageId, { sql });
            const hook = task.lifecycle!.onConfigChange!;
            await sql`DELETE FROM plugin_secrets WHERE plugin_id IN ('discogs', 'artist-enrichment', 'album-enrichment') AND key = 'DISCOGS_TOKEN'`;
            await hook(ctx as never, {});
            expect(await backlogIds(stageId)).toEqual([]);
            startRun.mockClear();
            await new PluginSecrets(sql).set('discogs', 'DISCOGS_TOKEN', 'test-discogs-token');
            try {
                await hook(ctx as never, {});
                expect(await backlogIds(stageId)).toEqual([parked]);
                expect(startRun.mock.calls.map((call) => call[0])).toContain(stageId);
                startRun.mockClear();
                await hook(ctx as never, {});
                expect(startRun).not.toHaveBeenCalled();
            } finally {
                await sql`DELETE FROM plugin_secrets WHERE plugin_id = 'discogs' AND key = 'DISCOGS_TOKEN'`;
            }
        },
    );
});
