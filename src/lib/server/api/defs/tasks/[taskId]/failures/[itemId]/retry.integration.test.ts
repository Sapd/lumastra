// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for the two statements backing
 * POST /api/v1/tasks/{taskId}/failures/{itemId}/retry.
 *
 * These ran against a real Postgres deliberately. Both statements were broken
 * from the day migration 15.0.0 landed — they queried `item_key`/`created_at`,
 * which that migration renamed to `item_id`/`occurred_at` — so every click of
 * the admin panel's per-item Retry button threw `column "item_key" does not
 * exist` before the retry hook ever ran. Nothing caught it, because the SQL sat
 * inline inside the route's `withAdvisoryLock` callback (outside its own
 * try/catch) where no test could reach it, and a mocked `sql` would have
 * happily accepted any column name at all.
 *
 * So a mock is worthless here by construction: only the real server parsing the
 * real statement against the real table proves the column names exist.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    recordFailure,
    findLatestFailureEventId,
    markFailureEventsResolved,
} from '$lib/server/database/queries/plugin-failure-events.queries.js';

const PLUGIN = 'itest_failureretry_a';

describe('failure retry statements (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM plugin_failure_events WHERE plugin_id LIKE 'itest_failureretry_%'`;
    });

    it('looks the item up by its real column names instead of throwing 42703', async () => {
        await recordFailure(sql, PLUGIN, 'item-1', 'boom', null);

        // The regression assertion. Pre-fix this rejected with
        // PostgresError 42703 `column "item_key" does not exist`.
        const eventId = await findLatestFailureEventId(sql, PLUGIN, 'item-1');

        expect(eventId).not.toBeNull();
        // BIGINT column: cast to text so it survives >2^53 rather than
        // silently narrowing through the global bigint->number parser.
        expect(typeof eventId).toBe('string');
        expect(eventId).toMatch(/^\d+$/);
    });

    it('orders by occurred_at, returning the newest event for the item', async () => {
        await recordFailure(sql, PLUGIN, 'item-1', 'older', null);
        await recordFailure(sql, PLUGIN, 'item-1', 'newer', null);

        // Two rows share a timestamp at ms resolution on a fast machine, so
        // pin the ordering explicitly rather than racing the clock.
        await sql`
            UPDATE plugin_failure_events
            SET occurred_at = now() - interval '1 hour'
            WHERE plugin_id = ${PLUGIN} AND reason = 'older'
        `;

        const eventId = await findLatestFailureEventId(sql, PLUGIN, 'item-1');
        const [{ reason }] = await sql<{ reason: string }[]>`
            SELECT reason FROM plugin_failure_events WHERE id = ${eventId!}::bigint
        `;
        expect(reason).toBe('newer');
    });

    it('returns null for an item that never failed, so the route 404s', async () => {
        await recordFailure(sql, PLUGIN, 'item-1', 'boom', null);

        expect(await findLatestFailureEventId(sql, PLUGIN, 'no-such-item')).toBeNull();
        expect(
            await findLatestFailureEventId(sql, 'itest_failureretry_other', 'item-1'),
        ).toBeNull();
    });

    it('resolves EVERY unresolved event for the item, not just the newest', async () => {
        // The second bug: a successful retry stamped only `reason`, never
        // `resolved_at`. Since the table is append-only and one row is added
        // per failed run, the item stayed in the panel forever and its
        // duplicates accumulated. Resolving only the newest row would leave
        // the older ones behind and reproduce that same symptom.
        await recordFailure(sql, PLUGIN, 'item-1', 'attempt 1', null);
        await recordFailure(sql, PLUGIN, 'item-1', 'attempt 2', null);
        await recordFailure(sql, PLUGIN, 'item-1', 'attempt 3', null);
        await recordFailure(sql, PLUGIN, 'other-item', 'untouched', null);

        const stamped = await markFailureEventsResolved(sql, PLUGIN, 'item-1');
        expect(stamped).toBe(3);

        const [{ unresolved }] = await sql<{ unresolved: number }[]>`
            SELECT COUNT(*)::int AS unresolved
            FROM plugin_failure_events
            WHERE plugin_id = ${PLUGIN} AND item_id = 'item-1' AND resolved_at IS NULL
        `;
        expect(unresolved).toBe(0);

        // A sibling item's backlog must survive — the UPDATE is scoped to the
        // pair, not the plugin.
        const [{ untouched }] = await sql<{ untouched: number }[]>`
            SELECT COUNT(*)::int AS untouched
            FROM plugin_failure_events
            WHERE plugin_id = ${PLUGIN} AND item_id = 'other-item' AND resolved_at IS NULL
        `;
        expect(untouched).toBe(1);
    });

    it('is idempotent — a second retry of a resolved item stamps nothing', async () => {
        await recordFailure(sql, PLUGIN, 'item-1', 'boom', null);

        expect(await markFailureEventsResolved(sql, PLUGIN, 'item-1')).toBe(1);
        // `resolved_at IS NULL` in the WHERE means the original timestamp is
        // preserved rather than bumped, so the panel's history stays honest.
        expect(await markFailureEventsResolved(sql, PLUGIN, 'item-1')).toBe(0);
    });

    it('still finds a resolved item, so a repeat retry 200s rather than 404ing', async () => {
        await recordFailure(sql, PLUGIN, 'item-1', 'boom', null);
        await markFailureEventsResolved(sql, PLUGIN, 'item-1');

        // The lookup is intentionally not filtered on `resolved_at IS NULL`:
        // a 404 on a row the operator can still see in a stale panel reads as
        // data loss. The route's 404 message is worded to match — "Failure
        // record for item '<id>' not found", with no claim about resolution,
        // because being resolved never produces that 404.
        expect(await findLatestFailureEventId(sql, PLUGIN, 'item-1')).not.toBeNull();
    });
});
