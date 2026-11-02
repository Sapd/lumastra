// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test — the pinned-broadcast read returns the PIN, not just the row.
 *
 * `pinnedAt` is what the wire contract defines "this row is pinned" as: the
 * drawer suppresses its dismiss control on that presence, and
 * `DELETE /notifications/{id}` answers 409 for exactly these rows. The query
 * shipped selecting only the base `user_notifications` columns and returning a
 * plain `UserNotificationRow` — so every row in `GET /notifications`'s `pinned`
 * array arrived without it, and the two halves disagreed: the announcement
 * rendered as an ordinary notification with a working-looking dismiss button,
 * and the user learned otherwise from a 409 after pressing it. Only rows
 * hydrated one-at-a-time through `getNotificationForUser` (the SSE path) were
 * right, which is why the bug was invisible in the live-delivery case and
 * present on every initial load and reload.
 *
 * Both halves are asserted here because they fail independently: the SELECT can
 * stop projecting `pinned_at` (no type error — the SQL is untyped at runtime,
 * and the field simply arrives undefined), or the mapper can stop surfacing it.
 * Driven against a stub `sql` tag rather than a live database on purpose — the
 * two things under test are the projection list and the mapping, neither of
 * which needs Postgres to have an opinion.
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
    listPinnedBroadcastsForUser,
    getNotificationForUser,
} from './user-notifications.queries.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOTIFICATION_ID = '22222222-2222-4222-8222-222222222222';
const PINNED_AT = new Date('2026-01-02T09:30:00.000Z');

/** A stub `sql` tag that records the assembled query text and replays rows. */
function stubSql(rows: unknown[]) {
    const queries: string[] = [];
    const sql = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
        queries.push(strings.join(' '));
        return Promise.resolve(rows);
    }) as unknown as postgres.Sql;
    return { sql, queries };
}

function pinnedDbRow(overrides: Record<string, unknown> = {}) {
    return {
        id: NOTIFICATION_ID,
        user_id: USER_ID,
        kind: 'admin.broadcast',
        payload: { broadcastId: '33333333-3333-4333-8333-333333333333', title: 'Maintenance' },
        read_at: null,
        created_at: new Date('2026-01-02T00:00:00.000Z'),
        expires_at: null,
        pinned_at: PINNED_AT,
        ...overrides,
    };
}

describe('listPinnedBroadcastsForUser', () => {
    it('projects the parent broadcast pinned_at', async () => {
        const { sql, queries } = stubSql([pinnedDbRow()]);

        await listPinnedBroadcastsForUser(sql, USER_ID);

        // The JOIN to admin_broadcasts was always there — it is the WHERE
        // clause that decides which rows are pinned. What was missing is the
        // projection, so this asserts on the SELECT list specifically.
        expect(queries).toHaveLength(1);
        expect(queries[0]).toContain('b.pinned_at AS pinned_at');
    });

    it('surfaces pinnedAt and isPinned on every returned row', async () => {
        const { sql } = stubSql([pinnedDbRow()]);

        const [row] = await listPinnedBroadcastsForUser(sql, USER_ID);

        expect(row.pinnedAt).toBe(PINNED_AT.toISOString());
        // Invariably true in THIS result: the join plus the two pin predicates
        // are the same test the mapper re-derives, so a row that reached here
        // is pinned by construction.
        expect(row.isPinned).toBe(true);
    });

    it('maps the ordinary notification fields exactly as the inbox list does', async () => {
        const { sql } = stubSql([pinnedDbRow()]);

        const [row] = await listPinnedBroadcastsForUser(sql, USER_ID);

        // The pinned block is rendered by the same presenter as `items`, so a
        // divergence here would show up as a differently-shaped row above the
        // list rather than as an error.
        expect(row).toMatchObject({
            id: NOTIFICATION_ID,
            userId: USER_ID,
            kind: 'admin.broadcast',
            readAt: null,
            createdAt: '2026-01-02T00:00:00.000Z',
            expiresAt: null,
        });
    });
});

describe('getNotificationForUser — pin state', () => {
    it('shares one derivation with the pinned list', async () => {
        const { sql } = stubSql([pinnedDbRow()]);

        const row = await getNotificationForUser(sql, NOTIFICATION_ID, USER_ID);

        // Same mapper, so a by-id hydrate of a pinned row and that row's entry
        // in the pinned block agree field for field. They must: a client
        // receives the SSE frame, hydrates by id, and has to recognise it as
        // the same announcement it is already showing above the list.
        expect(row).toMatchObject({ pinnedAt: PINNED_AT.toISOString(), isPinned: true });
    });

    it('reports an unpinned row as not pinned rather than as pinned-with-no-time', async () => {
        const { sql } = stubSql([pinnedDbRow({ pinned_at: null })]);

        const row = await getNotificationForUser(sql, NOTIFICATION_ID, USER_ID);

        // `pinned_at` is NULL both for a row with no parent broadcast and for
        // one whose pin has LAPSED — the query's CASE collapses them, because
        // "was pinned once" is not a state the wire contract has.
        expect(row).toMatchObject({ pinnedAt: null, isPinned: false });
    });
});
