// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    getTrickplayBacklogCounts,
    TRICKPLAY_PARAMS_PROCESSING_VERSION,
} from '../database/queries/trickplay-params.queries.js';
import { getTrickplayDisplayCounts } from './trickplay-coverage.service.js';

const rollback = new Error('rollback trickplay display fixture');
describe('trickplay display reading against PostgreSQL', () => {
    it('returns the same row checksum and avoids repeating the catalogue query', async () => {
        try {
            await getTestDb().begin(async (transaction) => {
                const tx = transaction as unknown as postgres.Sql;
                const schema = `trickplay_display_${crypto.randomUUID().replaceAll('-', '')}`;
                await tx`CREATE SCHEMA ${tx(schema)}`;
                await tx`SET LOCAL search_path TO ${tx(schema)}, public`;
                for (const name of [
                    'media_items',
                    'media_files',
                    'media_file_items',
                    'media_item_stage_state',
                    'trickplay_params',
                ]) {
                    await tx`CREATE TABLE ${tx(name)} (LIKE public.${tx(name)} INCLUDING ALL)`;
                }
                await tx`INSERT INTO media_items (id,title,media_type,has_files,processing_state)
                    SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
                        'Coverage movie '||n,'movie',true,'{}'::jsonb FROM generate_series(1,6000) n`;
                await tx`INSERT INTO media_files (id,file_path) SELECT id,'/fictional/'||id||'.mkv' FROM media_items`;
                await tx`INSERT INTO media_file_items (file_id,media_item_id) SELECT id,id FROM media_files`;
                await tx`INSERT INTO trickplay_params (media_item_id,file_id,width,height,interval_ms,tile_width,tile_height,thumbnail_count,source)
                    SELECT id,id,160,90,1000,10,10,500,'synthetic' FROM media_items LIMIT 2000`;
                await tx`ANALYZE media_items`;
                await tx`ANALYZE media_file_items`;
                const rawTimes: number[] = [],
                    displayTimes: number[] = [];
                let baseline;
                for (let i = 0; i < 3; i++) {
                    const start = performance.now();
                    baseline = await getTrickplayBacklogCounts(
                        tx,
                        TRICKPLAY_PARAMS_PROCESSING_VERSION,
                    );
                    rawTimes.push(performance.now() - start);
                }
                expect(baseline).toEqual({
                    analyzed: 2000,
                    remaining: 4000,
                    ineligible: 0,
                    failed: 0,
                });
                const display = await getTrickplayDisplayCounts(tx);
                for (let i = 0; i < 3; i++) {
                    const start = performance.now();
                    expect(await getTrickplayDisplayCounts(tx)).toEqual(baseline);
                    displayTimes.push(performance.now() - start);
                }
                const proof = await tx`WITH results AS (
                    SELECT 'old' AS variant,* FROM jsonb_to_record(${tx.json({ ...baseline! })}::jsonb)
                        AS r(analyzed int,remaining int,ineligible int,failed int)
                    UNION ALL
                    SELECT 'new',* FROM jsonb_to_record(${tx.json({ ...display })}::jsonb)
                        AS r(analyzed int,remaining int,ineligible int,failed int)
                ) SELECT variant,count(*)::int AS count,
                    md5(string_agg(row(analyzed,remaining,ineligible,failed)::text,'|' ORDER BY analyzed,remaining,ineligible,failed)) AS hash
                    FROM results GROUP BY variant ORDER BY variant`;
                expect(proof[0].count).toBe(proof[1].count);
                expect(proof[0].hash).toBe(proof[1].hash);
                const rows = await tx`SELECT count(*)::int AS count FROM media_items`;
                expect(rows[0].count).toBe(6000);
                expect(display).toEqual(baseline);
                console.log(
                    'TRICKPLAY_DISPLAY_PROOF',
                    JSON.stringify({
                        proof,
                        baseline,
                        display,
                        rawTimes,
                        displayTimes,
                        rawMedian: [...rawTimes].sort((a, b) => a - b)[1],
                        displayMedian: [...displayTimes].sort((a, b) => a - b)[1],
                    }),
                );
                throw rollback;
            });
        } catch (error) {
            if (error !== rollback) throw error;
        }
    });
});
