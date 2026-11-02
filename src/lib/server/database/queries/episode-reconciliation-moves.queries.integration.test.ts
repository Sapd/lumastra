// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    insertReconciliationMove,
    listReconciliationMoves,
    loadBlockedPairKeys,
    reconciliationPairKey,
    type ReconciliationMoveInsert,
} from './episode-reconciliation-moves.queries.js';

const SERIES_A = '00000000-0000-4000-a000-000000007001';
const SERIES_B = '00000000-0000-4000-a000-000000007002';
const SEASON_A = '00000000-0000-4000-a000-000000007003';
const SEASON_B = '00000000-0000-4000-a000-000000007004';
const EP_A1 = '00000000-0000-4000-a000-000000007005';
const EP_A2 = '00000000-0000-4000-a000-000000007006';
const EP_B1 = '00000000-0000-4000-a000-000000007007';

const ALL = [EP_A1, EP_A2, EP_B1, SEASON_A, SEASON_B, SERIES_A, SERIES_B];

function move(seriesId: string, episodeId: string, tmdb: string): ReconciliationMoveInsert {
    return {
        seriesId,
        episodeId,
        service: 'absolute-numbering',
        evidence: 'number-match',
        ghostId: null,
        tmdbEpisodeId: tmdb,
        fromParentId: null,
        fromSeason: 1,
        fromEpisode: 5,
        toParentId: null,
        toSeason: 3,
        toEpisode: 5,
        prevTitleBinding: 'position',
        prevTitle: 'Old',
        prevOverview: null,
        prevStillPath: '/old.jpg',
        mergeStats: { seasonsReparented: 0, itemsDeleted: 1 },
    };
}

describe('episode-reconciliation-moves queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        // Move records outlive their episode (episode_id is SET NULL): clear by series.
        await sql`DELETE FROM episode_reconciliation_moves WHERE series_id = ANY(${[SERIES_A, SERIES_B]})`;
        await sql`DELETE FROM media_items WHERE id = ANY(${ALL})`;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${SERIES_A}, 'Series A (Test)', 'tv', 'active', true),
                   (${SERIES_B}, 'Series B (Test)', 'tv', 'active', true)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
            VALUES (${SEASON_A}, 'Season 1', 'season', 'active', true, ${SERIES_A}, 1),
                   (${SEASON_B}, 'Season 1', 'season', 'active', true, ${SERIES_B}, 1)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES (${EP_A1}, 'A one', 'episode', 'active', true, ${SEASON_A}, 1, 1),
                   (${EP_A2}, 'A two', 'episode', 'active', true, ${SEASON_A}, 1, 2),
                   (${EP_B1}, 'B one', 'episode', 'active', true, ${SEASON_B}, 1, 1)
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM episode_reconciliation_moves WHERE series_id = ANY(${[SERIES_A, SERIES_B]})`;
        await sql`DELETE FROM media_items WHERE id = ANY(${ALL})`;
    });

    it('lists newest first, with series and episode titles, and filters by series', async () => {
        await insertReconciliationMove(sql, move(SERIES_A, EP_A1, '11'));
        await insertReconciliationMove(sql, move(SERIES_A, EP_A2, '12'));
        await insertReconciliationMove(sql, move(SERIES_B, EP_B1, '21'));

        const all = await listReconciliationMoves(sql, { limit: 200 });
        expect(all.filter((m) => [SERIES_A, SERIES_B].includes(m.seriesId))).toHaveLength(3);

        const onlyA = await listReconciliationMoves(sql, { seriesId: SERIES_A });
        expect(onlyA.map((m) => m.tmdbEpisodeId)).toEqual(['12', '11']);
        expect(onlyA[0]).toMatchObject({
            seriesTitle: 'Series A (Test)',
            episodeTitle: 'A two',
            service: 'absolute-numbering',
            fromSeason: 1,
            toSeason: 3,
            mergeStats: { seasonsReparented: 0, itemsDeleted: 1 },
            undoneAt: null,
        });
    });

    it('clamps the limit', async () => {
        await insertReconciliationMove(sql, move(SERIES_A, EP_A1, '11'));
        await insertReconciliationMove(sql, move(SERIES_A, EP_A2, '12'));

        expect(await listReconciliationMoves(sql, { limit: 1 })).toHaveLength(1);
        expect(await listReconciliationMoves(sql, { limit: 0 })).toHaveLength(1);
    });

    it('keeps the previous still_path and lists a move whose episode was deleted (episode_id cleared)', async () => {
        await insertReconciliationMove(sql, move(SERIES_A, EP_A1, '11'));
        await sql`DELETE FROM media_items WHERE id = ${EP_A1}`;

        const [row] = await listReconciliationMoves(sql, { seriesId: SERIES_A });

        expect(row).toMatchObject({
            episodeId: null,
            episodeTitle: null,
            prevStillPath: '/old.jpg',
        });
    });

    describe('block markers are per (episode, TMDB episode) pair', () => {
        const PROVIDER = 'lumastra-reconcile-absolute';
        const SEASON_PROVIDER = 'lumastra-reconcile-season-structure';

        async function marker(
            externalId: string,
            resolution: string | null,
            tmdb?: string,
            provider: string = PROVIDER,
        ): Promise<void> {
            await sql`
                INSERT INTO sync_quarantine
                    (provider, external_id, media_type, payload, reason, source, resolved_at, resolution)
                VALUES (${provider}, ${externalId}, 'episode', ${sql.json(tmdb ? { tmdbEpisodeId: tmdb } : {})},
                        'test', 'test', ${resolution ? sql`NOW()` : null}, ${resolution})
            `;
        }

        beforeEach(async () => {
            await sql`DELETE FROM sync_quarantine WHERE external_id LIKE ${EP_A1 + '%'} OR external_id LIKE ${EP_A2 + '%'}`;
        });

        afterAll(async () => {
            await sql`DELETE FROM sync_quarantine WHERE external_id LIKE ${EP_A1 + '%'} OR external_id LIKE ${EP_A2 + '%'}`;
        });

        it('two dismissed pairs of one episode are both blocked', async () => {
            await marker(reconciliationPairKey(EP_A1, '11'), 'dismissed');
            await marker(reconciliationPairKey(EP_A1, '12'), 'dismissed');

            const blocked = await loadBlockedPairKeys(sql, [EP_A1]);

            expect([...blocked].sort()).toEqual([`${EP_A1}:11`, `${EP_A1}:12`]);
        });

        it('open and reattached rows block nothing; other episodes are not read', async () => {
            await marker(reconciliationPairKey(EP_A1, '11'), null);
            await marker(reconciliationPairKey(EP_A1, '12'), 'reattached');
            await marker(reconciliationPairKey(EP_A2, '13'), 'dismissed');

            expect(await loadBlockedPairKeys(sql, [EP_A1])).toEqual(new Set());
        });

        it('a row keyed by the episode alone still blocks the pair its payload names', async () => {
            await marker(EP_A1, 'dismissed', '99');

            expect(await loadBlockedPairKeys(sql, [EP_A1])).toEqual(new Set([`${EP_A1}:99`]));
        });

        it('a marker of either reconciliation service blocks the pair; other providers do not', async () => {
            await marker(
                reconciliationPairKey(EP_A1, '11'),
                'dismissed',
                undefined,
                SEASON_PROVIDER,
            );
            await marker(
                reconciliationPairKey(EP_A1, '12'),
                'dismissed',
                undefined,
                'lumastra-reconcile',
            );

            expect(await loadBlockedPairKeys(sql, [EP_A1])).toEqual(new Set([`${EP_A1}:11`]));
            expect(await loadBlockedPairKeys(sql, [])).toEqual(new Set());
        });
    });
});
