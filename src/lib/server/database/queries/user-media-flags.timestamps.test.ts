// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `getUserFlags` used `SELECT *` while `UserMediaFlag` declares
 * `created_at: string` and `expires_at: string | null`. Both columns are
 * `timestamptz` in Postgres, and postgres.js registers a DEFAULT parser for
 * oids 1082/1114/1184 (date/timestamp/timestamptz) that returns a native
 * `Date` — `connection.ts` overrides only `bigint`. So the declared types
 * were a lie, and the lie had a live consequence: `defs/continue-watching/
 * dismissals.ts` emits `dismissedAt: flag.created_at` into
 * `DismissedItemSchema`, where the field is `z.string()`. Zod 4 rejects a
 * `Date` for `z.string()`, the throw is caught by that handler's try/catch
 * and returned as `internal_error` — a 500 for every user with at least one
 * `dismissed_cw` flag (43 rows across 5 users on the production catalogue
 * when this was found).
 *
 * The suite drives the REAL `getUserFlags` query builder through a `sql` mock
 * that derives each column's JS type from whether THAT call's own template
 * text carries the cast, mirroring what the driver actually does for the
 * query as written. Removing `::text` from the production SQL changes what
 * the mock hands back, so a revert fails these tests rather than passing
 * against a stale fixture.
 */

import { describe, it, expect, vi } from 'vitest';
import { getUserFlags } from './user-media-flags.queries.js';
import { DismissedItemSchema } from '$lib/schemas/api-dismissals-responses.js';
import type { UserId } from '$lib/shared/user-id.js';

/**
 * One `sql` template tag. `created_at`/`expires_at` come back as strings only
 * when the query text carries their `::text` cast; otherwise as `Date`s —
 * exactly what postgres.js returns for uncast timestamptz columns.
 */
function driverShapedSql() {
    return vi.fn().mockImplementation((strings: TemplateStringsArray) => {
        const text = strings.join('');
        return Promise.resolve([
            {
                id: 'flag-1',
                user_id: 'user-1',
                target_id: '22222222-2222-4222-8222-222222222222',
                target_type: 'series',
                flag_type: 'dismissed_cw',
                created_at: text.includes('created_at::text')
                    ? '2026-08-20 09:15:00+00'
                    : new Date('2026-08-20T09:15:00.000Z'),
                expires_at: text.includes('expires_at::text') ? null : null,
            },
        ]);
    });
}

describe('getUserFlags — timestamp columns reach a z.string() response field', () => {
    it('returns created_at as a string against the current (cast) SQL', async () => {
        const sql = driverShapedSql();

        const flags = await getUserFlags.all(sql as never, {
            userId: 'user-1' as UserId,
            flagType: 'dismissed_cw',
        });

        expect(typeof flags[0].created_at).toBe('string');
    });

    it('emits SQL that casts both timestamptz columns', async () => {
        const sql = driverShapedSql();

        await getUserFlags.all(sql as never, {
            userId: 'user-1' as UserId,
            flagType: 'dismissed_cw',
        });

        const text = (sql.mock.calls[0][0] as TemplateStringsArray).join('');
        expect(text).toContain('created_at::text');
        expect(text).toContain('expires_at::text');
        // The explicit column list is what makes the casts possible at all —
        // `SELECT *` cannot carry one.
        expect(text).not.toContain('SELECT *');
    });

    it('feeds DismissedItemSchema.dismissedAt without throwing', async () => {
        const sql = driverShapedSql();

        const flags = await getUserFlags.all(sql as never, {
            userId: 'user-1' as UserId,
            flagType: 'dismissed_cw',
        });

        // The exact shape defs/continue-watching/dismissals.ts builds per flag.
        expect(() =>
            DismissedItemSchema.parse({
                targetId: flags[0].target_id,
                targetType: 'series',
                title: 'Some Show',
                images: { poster: { href: '/api/images/x/poster' } },
                dismissedAt: flags[0].created_at,
            }),
        ).not.toThrow();
    });

    it('documents the failure mode a missing cast reproduces', () => {
        // Independent of the SQL-text detection above: a Date on this field
        // throws, because the schema declares it z.string(). That throw is
        // what the dismissals handler converted into a 500.
        expect(() =>
            DismissedItemSchema.parse({
                targetId: '22222222-2222-4222-8222-222222222222',
                targetType: 'series',
                title: 'Some Show',
                dismissedAt: new Date('2026-08-20T09:15:00.000Z') as unknown as string,
            }),
        ).toThrow();
    });
});
