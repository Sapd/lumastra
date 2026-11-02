// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A title whose recency moves (first file gained: has_files false -> true,
 * first_file_at NULL -> value) must schedule the browse-cache invalidation, and
 * only AFTER the refresh statement has run. A refresh that changed nothing must
 * not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const onContentAdded = vi.fn(async (_ids: string[]) => undefined);
vi.mock('$lib/server/cache/index.js', () => ({
    cacheInvalidation: { onContentAdded: (ids: string[]) => onContentAdded(ids) },
}));

import {
    refreshRecentlyAddedRecency,
    refreshRecentlyAddedRecencyForItems,
} from './browse.queries.js';

const TITLE = '11111111-1111-4111-8111-111111111111';
const EPISODE = '22222222-2222-4222-8222-222222222222';

/** Tagged-template fake: records statement order, answers from a queue. */
function fakeSql(answers: Array<Array<Record<string, string>>>, order: string[]) {
    const queue = [...answers];
    const tag = ((strings: TemplateStringsArray) => {
        const text = strings.join('?');
        if (!text.includes('WITH')) return Promise.resolve([]); // scope fragment
        order.push(text.includes('RETURNING') ? 'update' : 'resolve');
        return Promise.resolve(queue.shift() ?? []);
    }) as unknown as postgres.Sql;
    return tag;
}

beforeEach(() => {
    onContentAdded.mockClear();
});

describe('recency refresh -> browse cache invalidation', () => {
    it('fires onContentAdded with the changed titles after the UPDATE ran', async () => {
        const order: string[] = [];
        onContentAdded.mockImplementation(async () => {
            order.push('invalidate');
        });

        const changed = await refreshRecentlyAddedRecency(fakeSql([[{ id: TITLE }]], order), [
            TITLE,
        ]);

        expect(changed).toEqual([TITLE]);
        expect(onContentAdded).toHaveBeenCalledWith([TITLE]);
        expect(order).toEqual(['update', 'invalidate']);
    });

    it('resolves an episode id to its title, then invalidates for the title', async () => {
        const order: string[] = [];
        const sql = fakeSql([[{ top_id: TITLE }], [{ id: TITLE }]], order);

        await refreshRecentlyAddedRecencyForItems(sql, [EPISODE]);

        expect(order).toEqual(['resolve', 'update']);
        expect(onContentAdded).toHaveBeenCalledWith([TITLE]);
    });

    it('does not invalidate when no title changed', async () => {
        const changed = await refreshRecentlyAddedRecency(fakeSql([[]], []), [TITLE]);

        expect(changed).toEqual([]);
        expect(onContentAdded).not.toHaveBeenCalled();
    });

    it('does not fail the refresh when the invalidation throws', async () => {
        onContentAdded.mockRejectedValueOnce(new Error('cache down'));

        await expect(
            refreshRecentlyAddedRecency(fakeSql([[{ id: TITLE }]], []), [TITLE]),
        ).resolves.toEqual([TITLE]);
    });
});
