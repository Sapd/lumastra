// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Behavioural tests for the decline-loop backoff and its alert derive.
 *
 * Each `it` below corresponds to a defect an earlier revision of this design
 * actually shipped past review, and the comment says which — because in every
 * case the obvious version of the test passed while the bug was live.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { insertPendingRow, markRunning, markCompleted } from './stage-state.queries.js';
import { resetRunningToPending } from './stage-state.queries.js';
import { loadDeclineLoopRows, countDeclineLoopRowsByStage } from './attention.queries.js';
import {
    ALERT_FLOOR,
    FREE_DECLINES,
    ALERT_AGE_HOURS,
    BACKOFF_CEIL_MIN,
} from '$lib/server/tasks/decline-loop.js';

const STAGE = `decline-loop-test-${Math.random().toString(36).slice(2, 10)}`;

async function insertTestMediaItem(sql: postgres.Sql): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, 'movie', ${'Test ' + id.slice(0, 6)})
    `;
    return id;
}

/** One full decline cycle: claim the row, then have the task decline it. */
async function decline(sql: postgres.Sql, itemId: string, runId = crypto.randomUUID()) {
    await markRunning(sql, { mediaItemId: itemId, stageId: STAGE, runId });
    return resetRunningToPending(sql, { mediaItemId: itemId, stageId: STAGE, runId });
}

async function seed(sql: postgres.Sql): Promise<string> {
    const itemId = await insertTestMediaItem(sql);
    await insertPendingRow(sql, { mediaItemId: itemId, stageId: STAGE, processingVersion: 1 });
    return itemId;
}

async function row(sql: postgres.Sql, itemId: string) {
    const [r] = await sql<
        {
            status: string;
            declines: number;
            declines_since: Date | null;
            next_eligible_at: Date | null;
            attempt: number;
        }[]
    >`
        SELECT status, declines, declines_since, next_eligible_at, attempt
          FROM media_item_stage_state
         WHERE media_item_id = ${itemId}::uuid AND stage_id = ${STAGE}
    `;
    return r;
}

/** Backdate a streak so the age predicate can be exercised without waiting. */
async function ageStreak(sql: postgres.Sql, itemId: string, hours: number) {
    await sql`
        UPDATE media_item_stage_state
           SET declines_since = now() - make_interval(hours => ${hours}::int)
         WHERE media_item_id = ${itemId}::uuid AND stage_id = ${STAGE}
    `;
}

describe('decline-loop backoff', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM media_item_stage_state WHERE stage_id = ${STAGE}`;
        await sql`DELETE FROM media_items WHERE title LIKE 'Test %'`;
    });

    it('leaves the first FREE_DECLINES immediately eligible, exactly as before', async () => {
        const itemId = await seed(sql);
        for (let i = 1; i <= FREE_DECLINES; i++) {
            const res = await decline(sql, itemId);
            expect(res.declines).toBe(i);
            const r = await row(sql, itemId);
            expect(r.status).toBe('pending');
            expect(r.next_eligible_at).toBeNull();
        }
    });

    it('never touches `attempt` — declining is not a failed attempt', async () => {
        const itemId = await seed(sql);
        for (let i = 0; i < FREE_DECLINES + 3; i++) await decline(sql, itemId);
        expect((await row(sql, itemId)).attempt).toBe(0);
    });

    it('stamps declines_since on the first decline only', async () => {
        const itemId = await seed(sql);
        await decline(sql, itemId);
        const first = (await row(sql, itemId)).declines_since;
        expect(first).not.toBeNull();
        await decline(sql, itemId);
        expect((await row(sql, itemId)).declines_since?.getTime()).toBe(first?.getTime());
    });

    it('backs off on the demotion onset and doubles to the ceiling', async () => {
        const itemId = await seed(sql);
        for (let i = 0; i < FREE_DECLINES; i++) await decline(sql, itemId);

        // Expectations derived from the constants, never hardcoded: pinning the
        // numbers would pass just as happily with the curve and the constants
        // drifting apart together.
        const expectedMinutes = (declines: number) =>
            Math.min(
                2 ** Math.min(declines - FREE_DECLINES, Math.ceil(Math.log2(BACKOFF_CEIL_MIN))),
                BACKOFF_CEIL_MIN,
            );

        for (let n = FREE_DECLINES + 1; n <= FREE_DECLINES + 7; n++) {
            await decline(sql, itemId);
            const r = await row(sql, itemId);
            expect(r.declines).toBe(n);
            expect(r.next_eligible_at).not.toBeNull();
            const minutes = (r.next_eligible_at!.getTime() - Date.now()) / 60_000;
            expect(minutes).toBeGreaterThan(expectedMinutes(n) - 1);
            expect(minutes).toBeLessThanOrEqual(expectedMinutes(n) + 1);
        }
    });

    /**
     * R2's blocker. It capped the RESULT but not the exponent
     * (`LEAST(2^n * interval '1 minute', interval '1 hour')`), which multiplies
     * first — and interval microseconds are int64, so it raised 22003 at around
     * 51 declines. The decline write then threw, the row wedged at `running`,
     * and the breaker deleted itself on exactly the rows it had been right
     * about, after roughly two days of looping.
     *
     * A test that only checked "the ceiling holds" passed the whole time. This
     * one goes far past any plausible ceiling check.
     */
    it('does not overflow at absurd decline counts', async () => {
        const itemId = await seed(sql);
        for (const n of [100, 100_000, 2_000_000_000]) {
            await sql`
                UPDATE media_item_stage_state SET declines = ${n}
                 WHERE media_item_id = ${itemId}::uuid AND stage_id = ${STAGE}
            `;
            const res = await decline(sql, itemId);
            expect(res.declines).toBe(n + 1);
            const r = await row(sql, itemId);
            const minutes = (r.next_eligible_at!.getTime() - Date.now()) / 60_000;
            expect(minutes).toBeLessThanOrEqual(BACKOFF_CEIL_MIN + 1);
        }
    });

    it('a completion ends the streak', async () => {
        const itemId = await seed(sql);
        for (let i = 0; i < FREE_DECLINES + 2; i++) await decline(sql, itemId);
        expect((await row(sql, itemId)).declines).toBeGreaterThan(0);

        const runId = crypto.randomUUID();
        await markRunning(sql, { mediaItemId: itemId, stageId: STAGE, runId });
        await markCompleted(sql, { mediaItemId: itemId, stageId: STAGE, runId });

        const r = await row(sql, itemId);
        expect(r.declines).toBe(0);
        expect(r.declines_since).toBeNull();
    });
});

describe('decline-loop alert derive', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM media_item_stage_state WHERE stage_id = ${STAGE}`;
        await sql`DELETE FROM media_items WHERE title LIKE 'Test %'`;
    });

    async function declinedAndAged(hours: number, times = ALERT_FLOOR): Promise<string> {
        const itemId = await seed(sql);
        for (let i = 0; i < times; i++) await decline(sql, itemId);
        await ageStreak(sql, itemId, hours);
        return itemId;
    }

    function forStage<T extends { stage_id: string }>(rows: T[]): T[] {
        return rows.filter((r) => r.stage_id === STAGE);
    }

    /**
     * R1's blocker, and the single most important test here.
     *
     * R1 killed looping rows outright, gated on "did a sibling complete?" — on
     * the theory that a global block stops everything, so sibling progress
     * proves the problem is item-specific. Real blocks are frequently PARTIAL:
     * an hourly rate cap admits a trickle, so the blocked population satisfies
     * its own discriminator and the design mass-suppressed items whose only
     * fault was being behind a quota.
     *
     * R1's own regression test modelled a TOTAL block, so it passed throughout.
     * This models the partial one, and asserts the thing that actually matters:
     * a declined row is still `pending`, still eligible, still nobody's tombstone.
     */
    it('a partial block suppresses nothing — decliners stay pending and recoverable', async () => {
        const blocked = await seed(sql);
        const trickle = await seed(sql);

        for (let i = 0; i < FREE_DECLINES + 6; i++) await decline(sql, blocked);

        // A sibling completes throughout, exactly as a rate-cap trickle does.
        const runId = crypto.randomUUID();
        await markRunning(sql, { mediaItemId: trickle, stageId: STAGE, runId });
        await markCompleted(sql, { mediaItemId: trickle, stageId: STAGE, runId });

        const r = await row(sql, blocked);
        expect(r.status).toBe('pending');
        expect(r.attempt).toBe(0);

        // And it recovers the moment its block clears — no operator action.
        const runId2 = crypto.randomUUID();
        await markRunning(sql, { mediaItemId: blocked, stageId: STAGE, runId: runId2 });
        await markCompleted(sql, { mediaItemId: blocked, stageId: STAGE, runId: runId2 });
        const after = await row(sql, blocked);
        expect(after.status).toBe('completed');
        expect(after.declines).toBe(0);
    });

    /**
     * R3's blocker. The alert floor was set one above the demotion onset, and
     * because a demoted row sorts behind the whole NULL-pending backlog it may
     * never be picked again — freezing `declines` one short of a threshold it
     * could never reach. A test written at floor+1 declines would have passed
     * while the bug shipped, so this pins the row at EXACTLY the floor and never
     * touches it again.
     */
    it('alerts on age for a row pinned at exactly ALERT_FLOOR and never picked again', async () => {
        await declinedAndAged(ALERT_AGE_HOURS + 1, ALERT_FLOOR);
        const rows = forStage(await loadDeclineLoopRows(sql, 50));
        expect(rows).toHaveLength(1);
        expect(rows[0].declines).toBe(ALERT_FLOOR);
    });

    it('does not alert before the streak has aged', async () => {
        await declinedAndAged(ALERT_AGE_HOURS - 1, ALERT_FLOOR);
        expect(forStage(await loadDeclineLoopRows(sql, 50))).toHaveLength(0);
    });

    /**
     * The deploy vector. `stage-version-detector` flips every completed row for
     * a stage to `obsolete` on a processing-version bump, setting only `status`
     * and `updated_at`. If a completed row could carry a stale streak, the first
     * deploy after any quota block would raise a mass false "not progressing
     * since three weeks" alert. The reset invariant is what prevents it.
     */
    it('a completed row that once declined does not alert after a version bump', async () => {
        const itemId = await seed(sql);
        for (let i = 0; i < ALERT_FLOOR; i++) await decline(sql, itemId);

        const runId = crypto.randomUUID();
        await markRunning(sql, { mediaItemId: itemId, stageId: STAGE, runId });
        await markCompleted(sql, { mediaItemId: itemId, stageId: STAGE, runId });

        // What stage-version-detector does, verbatim: status only.
        await sql`
            UPDATE media_item_stage_state
               SET status = 'obsolete', updated_at = now()
             WHERE media_item_id = ${itemId}::uuid AND stage_id = ${STAGE}
        `;
        await ageStreak(sql, itemId, ALERT_AGE_HOURS + 1);

        expect(forStage(await loadDeclineLoopRows(sql, 50))).toHaveLength(0);
    });

    /**
     * A dismissed item is permanently unsweepable — nothing can ever complete or
     * re-decline it — so without the liveness guard its streak would age forever
     * and the alert could never auto-resolve.
     */
    it('never alerts for a dismissed item', async () => {
        const itemId = await declinedAndAged(ALERT_AGE_HOURS + 1, ALERT_FLOOR);
        await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${itemId}::uuid`;
        expect(forStage(await loadDeclineLoopRows(sql, 50))).toHaveLength(0);
    });

    /**
     * The count must come from a real aggregate, not the sample length, or the
     * ack watermark caps at the sample limit no matter how large the population
     * — the trap `countDeadLetterItemsByStage` already exists to avoid.
     */
    it('counts the true per-stage population, not the sample size', async () => {
        for (let i = 0; i < 4; i++) await declinedAndAged(ALERT_AGE_HOURS + 1, ALERT_FLOOR);
        const sample = forStage(await loadDeclineLoopRows(sql, 2));
        expect(sample).toHaveLength(2);
        expect((await countDeclineLoopRowsByStage(sql)).get(STAGE)).toBe(4);
    });
});
