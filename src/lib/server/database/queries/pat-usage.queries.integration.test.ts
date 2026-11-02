// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { PatUsageBatcher } from '../../oauth/pat-usage-batcher.js';
import { recordPatUsage } from './pat-usage.queries.js';
const rollback = new Error('rollback PAT usage fixture');
afterEach(() => {
    vi.useRealTimers();
});
describe('PAT usage persistence', () => {
    it('preserves every token column and use count while coalescing 100 uses into two writes', async () => {
        try {
            await getTestDb().begin(async (transaction) => {
                const tx = transaction as unknown as postgres.Sql;
                const schema = `pat_usage_${crypto.randomUUID().replaceAll('-', '')}`;
                await tx`CREATE SCHEMA ${tx(schema)}`;
                await tx`SET LOCAL search_path TO ${tx(schema)},public`;
                await tx`CREATE TABLE personal_access_tokens (LIKE public.personal_access_tokens INCLUDING ALL)`;
                await tx`CREATE TABLE old_personal_access_tokens (LIKE personal_access_tokens INCLUDING ALL)`;
                const hash = 'a'.repeat(64);
                await tx`INSERT INTO personal_access_tokens (token_hash,token_prefix,user_id,name,scopes,user_groups)
                    VALUES (${hash},'pat_fixture','00000000-0000-4000-8000-000000000001','Usage fixture',ARRAY['read'],ARRAY[]::text[])`;
                await tx`INSERT INTO old_personal_access_tokens OVERRIDING SYSTEM VALUE SELECT * FROM personal_access_tokens`;
                const [clock] = await tx<{ now: Date }[]>`SELECT now() AS now`;
                const captured: { query: string; parameters: unknown[] } = {
                    query: '',
                    parameters: [],
                };
                const capture = ((parts: TemplateStringsArray, ...values: unknown[]) => {
                    captured.query = parts
                        .map((part, index) => part + (index < values.length ? `$${index + 1}` : ''))
                        .join('');
                    captured.parameters = values;
                    return Promise.resolve([]);
                }) as unknown as postgres.Sql;
                await recordPatUsage(capture, {
                    tokenHash: hash,
                    uses: 100,
                    usedAt: clock.now,
                    clientIp: '192.0.2.2',
                });
                const newPlan = await tx.unsafe(
                    'EXPLAIN ' + captured.query,
                    captured.parameters as postgres.ParameterOrJSON<never>[],
                );
                const oldPlan = await tx`EXPLAIN UPDATE old_personal_access_tokens
                    SET last_used_at=NOW(),last_used_ip='192.0.2.2',usage_count=usage_count+1 WHERE token_hash=${hash}`;
                console.log('PAT_USAGE_PLANS', JSON.stringify({ oldPlan, newPlan }));
                // NOW() is transaction-stable in the frozen old SQL. Use that
                // same request clock in the batcher; normalize only the Date
                // driver's sub-millisecond precision in the row checksum.
                vi.useFakeTimers({ toFake: ['Date'] });
                vi.setSystemTime(clock.now);
                const beforeTimes: number[] = [],
                    afterTimes: number[] = [],
                    writes: number[] = [];
                for (let sample = 0; sample < 3; sample++) {
                    let start = performance.now();
                    for (let i = 0; i < 100; i++) {
                        const ip = i % 2 ? '192.0.2.2' : '192.0.2.1';
                        await tx`UPDATE old_personal_access_tokens SET last_used_at=NOW(),last_used_ip=${ip},
                            usage_count=usage_count+1 WHERE token_hash=${hash}`;
                    }
                    beforeTimes.push(performance.now() - start);
                    let written = 0;
                    const batcher = new PatUsageBatcher(
                        async (batch) => {
                            written++;
                            await recordPatUsage(tx, batch);
                        },
                        (error) => {
                            throw error;
                        },
                    );
                    start = performance.now();
                    for (let i = 0; i < 100; i++)
                        await batcher.record(hash, i % 2 ? '192.0.2.2' : '192.0.2.1');
                    expect(written).toBe(1);
                    await batcher.shutdown();
                    afterTimes.push(performance.now() - start);
                    expect(written).toBe(2);
                    writes.push(written);
                }
                const proof = await tx`WITH old AS (
                    SELECT (jsonb_populate_record(NULL::personal_access_tokens,to_jsonb(t)||
                        jsonb_build_object('last_used_at',date_trunc('milliseconds',last_used_at)))).*
                    FROM old_personal_access_tokens t
                ),new AS (
                    SELECT (jsonb_populate_record(NULL::personal_access_tokens,to_jsonb(t)||
                        jsonb_build_object('last_used_at',date_trunc('milliseconds',last_used_at)))).*
                    FROM personal_access_tokens t
                ) SELECT 'old' AS variant,count(*)::int AS count,md5(string_agg(old::text,'|' ORDER BY id)) AS hash FROM old
                    UNION ALL SELECT 'new',count(*)::int,md5(string_agg(new::text,'|' ORDER BY id)) FROM new`;
                expect(proof[0].count).toBe(1);
                expect(proof[1].count).toBe(1);
                expect(proof[0].hash).toBe(proof[1].hash);
                const [row] = await tx`SELECT usage_count,last_used_ip FROM personal_access_tokens`;
                expect(Number(row.usage_count)).toBe(300);
                expect(row.last_used_ip).toBe('192.0.2.2');
                console.log(
                    'PAT_USAGE_PROOF',
                    JSON.stringify({
                        proof,
                        uses: 300,
                        writes,
                        beforeTimes,
                        afterTimes,
                        beforeMedian: [...beforeTimes].sort((a, b) => a - b)[1],
                        afterMedian: [...afterTimes].sort((a, b) => a - b)[1],
                    }),
                );
                // A delayed batch from another replica must add its uses without
                // moving the most recent timestamp or IP backwards.
                await recordPatUsage(tx, {
                    tokenHash: hash,
                    uses: 2,
                    clientIp: '192.0.2.3',
                    usedAt: new Date(clock.now.getTime() - 60_000),
                });
                const [latest] =
                    await tx`SELECT usage_count,last_used_ip,last_used_at FROM personal_access_tokens`;
                expect(Number(latest.usage_count)).toBe(302);
                expect(latest.last_used_ip).toBe('192.0.2.2');
                expect(latest.last_used_at).toEqual(clock.now);
                throw rollback;
            });
        } catch (error) {
            if (error !== rollback) throw error;
        }
    });
});
