// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { refreshAudiobookLibrarySettings } from './audiobook-library.queries.js';

it('refreshes many books with one update round trip', async () => {
    const rows = [
        { id: 'a', title: 'Der Wald' },
        { id: 'b', title: 'Das Tor' },
        { id: 'c', title: 'The River' },
    ];
    const sql = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows);
    await refreshAudiobookLibrarySettings(sql as unknown as postgres.Sql, 'path', 'de', 'group');
    const updates = sql.mock.calls.filter((call) => /UPDATE media_items/i.test(String(call[0])));
    expect(updates).toHaveLength(1);
    expect(updates[0].flat(2)).toEqual(
        expect.arrayContaining(['a', 'b', 'c', 'wald', 'tor', 'the river']),
    );
});
