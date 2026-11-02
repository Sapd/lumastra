// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * getEpgMatchReviewData against real PostgreSQL: epg_match_confidence is
 * numeric(4,3), which postgres.js returns as a string unless the query casts
 * it. The review UI sorts, compares and formats the score as a number.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { createChannelWithMediaItem, getEpgMatchReviewData } from './livetv-channels.queries.js';

describe('getEpgMatchReviewData', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE livetv_programs, livetv_epg_channels, livetv_channels, livetv_categories, livetv_backup_groups, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
    });

    it('returns the match confidence as a number', async () => {
        const sourceId = crypto.randomUUID();
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, max_streams)
            VALUES (${sourceId}::uuid, 'Test Source', 'm3u', 2)
        `;
        const matched = crypto.randomUUID();
        const unmatched = crypto.randomUUID();
        for (const id of [matched, unmatched]) {
            await createChannelWithMediaItem(sql, {
                id,
                name: id === matched ? 'Kanal Neun' : 'Kanal Zehn',
                streamUrl: `http://stream.example/${id}.ts`,
                sourceId,
            });
        }
        await sql`
            UPDATE livetv_channels
               SET epg_channel_id = 'kn.de', epg_match_confidence = 0.855
             WHERE id = ${matched}
        `;

        const rows = await getEpgMatchReviewData(sql, sourceId);
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get(matched)?.epg_match_confidence).toBe(0.855);
        expect(byId.get(unmatched)?.epg_match_confidence).toBeNull();
    });
});
