// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { getContinueWatchingFromDb } from './watch-state.queries.js';

type SqlFragment = { __sql: string; then?: unknown };

function isSqlFragment(value: unknown): value is SqlFragment {
    return (
        typeof value === 'object' &&
        value !== null &&
        '__sql' in value &&
        typeof (value as SqlFragment).__sql === 'string'
    );
}

function makeSql(returnValue: unknown[] = []) {
    const calls: string[] = [];

    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        let text = strings[0] ?? '';
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            text += isSqlFragment(value) ? value.__sql : '?';
            text += strings[i + 1] ?? '';
        }

        return {
            __sql: text,
            then(resolve: (value: unknown[]) => unknown, reject?: (reason?: unknown) => unknown) {
                calls.push(text);
                return Promise.resolve(returnValue).then(resolve, reject);
            },
        };
    }) as unknown as postgres.Sql & { unsafe: (raw: string) => SqlFragment };

    sql.unsafe = ((raw: string) => ({
        __sql: raw,
    })) as unknown as typeof sql.unsafe;

    return { sql, calls };
}

describe('getContinueWatchingFromDb SQL', () => {
    it('does not hard-exclude resumes just because a later episode is watched', async () => {
        const { sql, calls } = makeSql();

        await getContinueWatchingFromDb.all(sql, {
            userId: toUserId(randomUUID()),
            limit: 10,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 180,
            collapsePerSeries: true,
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]).not.toContain('uws_later');
        expect(calls[0]).not.toContain('season_later');
        expect(calls[0]).not.toContain('this earlier episode is no longer');
    });

    it('requires configured progress instead of promoting brief engagement', async () => {
        const { sql, calls } = makeSql();

        await getContinueWatchingFromDb.all(sql, {
            userId: toUserId(randomUUID()),
            limit: 10,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 180,
            collapsePerSeries: true,
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]).not.toContain('highest_session_elapsed_ms >=');
    });
});
