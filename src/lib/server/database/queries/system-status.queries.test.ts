// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A failing COUNT must not read as an empty library or zero users: the admin
 * home treats zero items as a first run and swapped Now Playing and Processing
 * for the setup checklist whenever this query timed out.
 */

import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { getMediaStats, getUserStats } from './system-status.queries.js';

/** A tagged-template `sql` stand-in that answers by the query's text. */
function fakeSql(answer: (text: string) => unknown): postgres.Sql {
    return ((strings: TemplateStringsArray) => {
        const text = strings.join('?');
        return Promise.resolve().then(() => answer(text));
    }) as unknown as postgres.Sql;
}

const ALL_TABLES = ['media_items', 'media_embeddings', 'users'].map((table_name) => ({
    table_name,
}));

describe('system status counts', () => {
    it('getMediaStats throws when the item count fails', async () => {
        const sql = fakeSql((text) => {
            if (text.includes('information_schema.tables')) return ALL_TABLES;
            throw new Error('canceling statement due to statement timeout');
        });

        await expect(getMediaStats(sql)).rejects.toThrow(/statement timeout/);
    });

    it('getMediaStats keeps the item count when only the embedding coverage fails', async () => {
        const sql = fakeSql((text) => {
            if (text.includes('information_schema.tables')) return ALL_TABLES;
            if (text.includes('FROM media_items')) return [{ count: '42' }];
            throw new Error('embeddings aggregate timed out');
        });

        const stats = await getMediaStats(sql);

        expect(stats.totalMediaItems).toBe(42);
        expect(stats.libraryEmbeddings).toBe(0);
    });

    it('getUserStats throws when the user count fails', async () => {
        const sql = fakeSql((text) => {
            if (text.includes('information_schema.tables')) return ALL_TABLES;
            throw new Error('connection reset');
        });

        await expect(getUserStats(sql)).rejects.toThrow(/connection reset/);
    });
});
