// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from 'postgres';
import { expect, it } from 'vitest';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { runStageDisposition } from './stage-disposition-runner.js';
import type { StageGuardContext } from '$lib/types/pipeline.js';

const logger: StageGuardContext['logger'] = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
        return logger;
    },
};

it.each(['completed', 'skipped_transient', 'skipped_permanent'] as const)(
    '%s disposition keeps its state guards and can use the sweep index with a generic plan',
    async (disposeAs) => {
        let update: string | undefined;
        const sql = postgres(getTestDatabaseUrl(), {
            max: 1,
            debug: (_conn, query) => {
                if (/^\s*UPDATE media_item_stage_state s/.test(query)) {
                    update = query;
                }
            },
        });
        const stageId = `disposition-plan-${crypto.randomUUID()}`;
        const rollback = new Error('rollback disposition fixtures');
        try {
            await sql
                .begin(async (tx) => {
                    const statuses = [
                        'pending',
                        'failed_transient',
                        'skipped_transient',
                        'obsolete',
                        'running',
                        'completed',
                        'skipped_permanent',
                        'failed_permanent',
                    ];
                    const ids = statuses.map(() => crypto.randomUUID());
                    const futureId = crypto.randomUUID();
                    for (const [i, status] of statuses.entries()) {
                        await tx`INSERT INTO media_items (id, title, media_type)
                        VALUES (${ids[i]}, 'Disposition plan fixture', 'movie')`;
                        await tx`INSERT INTO media_item_stage_state
                        (media_item_id, stage_id, processing_version, status)
                        VALUES (${ids[i]}, ${stageId}, 1, ${status})`;
                    }
                    await tx`INSERT INTO media_items (id, title, media_type)
                    VALUES (${futureId}, 'Disposition backoff fixture', 'movie')`;
                    await tx`INSERT INTO media_item_stage_state
                    (media_item_id, stage_id, processing_version, status, next_eligible_at)
                    VALUES (${futureId}, ${stageId}, 1, 'skipped_transient', now() + interval '1 day')`;
                    await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
                    const db = tx as unknown as postgres.Sql;
                    expect(
                        await runStageDisposition(
                            db,
                            {
                                id: stageId,
                                terminalDisposition: {
                                    kind: 'predicate',
                                    ruleId: 'plan-fixture',
                                    reason: 'plan-fixture',
                                    disposeAs,
                                    excludes: (s) => s`true`,
                                    retryAfterMs: 60_000,
                                },
                            },
                            { sql: db, logger },
                        ),
                    ).toBe(disposeAs === 'completed' ? 5 : 4);
                    const rows = await tx`SELECT media_item_id, status FROM media_item_stage_state
                    WHERE stage_id = ${stageId}`;
                    for (const [i, status] of statuses.entries()) {
                        expect(rows.find((r) => r.media_item_id === ids[i])?.status).toBe(
                            i < 4 ? disposeAs : status,
                        );
                    }
                    expect(rows.find((r) => r.media_item_id === futureId)?.status).toBe(
                        disposeAs === 'completed' ? 'completed' : 'skipped_transient',
                    );
                    expect(update).toBeDefined();
                    await tx`SET LOCAL enable_seqscan = off`;
                    // GENERIC_PLAN leaves $n unbound, exactly like a reused generic
                    // prepared plan. An ordinary EXPLAIN with values can hide this bug.
                    const plan = await tx.unsafe(`EXPLAIN (GENERIC_PLAN) ${update!}`);
                    expect(JSON.stringify(plan)).toMatch(/idx_stage_state_(sweep|queue_position)/);
                    expect(JSON.stringify(plan)).toMatch(/Index Cond:.*stage_id/);
                    // Negative control: the former bound-array shape cannot prove
                    // either partial index predicate, even with seqscan discouraged.
                    const lastParam = Math.max(
                        ...[...update!.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
                    );
                    const oldQuery = update!.replace(
                        "s.status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete')",
                        `s.status = ANY($${lastParam + 1}::text[])`,
                    );
                    const oldPlan = await tx.unsafe(`EXPLAIN (GENERIC_PLAN) ${oldQuery}`);
                    expect(JSON.stringify(oldPlan)).not.toMatch(
                        /idx_stage_state_(sweep|queue_position)/,
                    );
                    throw rollback;
                })
                .catch((err: unknown) => {
                    if (err !== rollback) throw err;
                });
        } finally {
            await sql.end();
        }
    },
);
