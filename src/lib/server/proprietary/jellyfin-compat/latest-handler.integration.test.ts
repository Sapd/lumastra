// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/Items/Latest` slot resolution against real rows: a series is placed by its
 * newest episode that passes the filters (GetLatestTvShowItems), never by a
 * newer watched or hidden episode.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import {
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import { parseLatestQuery, resolveLatestIds } from './latest-handler.js';

let sql: postgres.Sql;
let userId: UserId;

beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [
        'user_media_state',
        'provider_metadata',
        'media_file_items',
        'media_files',
        'library_groups',
        'media_items',
    ]);
    userId = toUserId(randomUUID());
    await ensureTestUser(sql, userId);
});

const ago = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

async function item(
    title: string,
    type: string,
    parentId: string | null,
    fileAt?: string,
    group: string | null = null,
): Promise<string> {
    const leaf = type === 'movie' || type === 'episode';
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, parent_id, has_files, season_number, episode_number, runtime_seconds)
        VALUES (${title}, ${type}, 'active', ${parentId}, ${leaf}, NULL, NULL, 1500)
        RETURNING id`;
    if (leaf) {
        const [f] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
            VALUES (${`/latest/${row.id}.mkv`}, ${group}, ${fileAt ?? ago(0)}, ${fileAt ?? ago(0)})
            RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${f.id}, ${row.id}, true)`;
    }
    return row.id;
}

async function watched(id: string): Promise<void> {
    await sql`INSERT INTO user_media_state (user_id, media_id, is_watched, watch_count, last_watched_at, last_event_at, last_event_source)
              VALUES (${userId}::uuid, ${id}::uuid, true, 1, NOW(), NOW(), 'lumastra')`;
}

/** Two seasons, each with an extra long-ago episode, so one new episode stays an episode. */
async function series(title: string, oldAt: string, newAt: string): Promise<[string, string]> {
    const s = await item(title, 'tv', null);
    const s1 = await item('Season 1', 'season', s);
    const s2 = await item('Season 2', 'season', s);
    await item(`${title} filler 1`, 'episode', s1, ago(500));
    await item(`${title} filler 2`, 'episode', s2, ago(500));
    return [
        await item(`${title} old`, 'episode', s1, oldAt),
        await item(`${title} new`, 'episode', s2, newAt),
    ];
}

describe('resolveLatestIds (GroupItems=true, HidePlayedInLatest)', () => {
    it('a series whose newest episode is watched is placed by its newest UNWATCHED episode', async () => {
        const movie = await item('Movie', 'movie', null, ago(2));
        const [aOld, aNew] = await series('A', ago(10), ago(1));
        await watched(aNew);
        const [, bNew] = await series('B', ago(48), ago(5));

        const q = parseLatestQuery(new URL('http://x/Items/Latest?Limit=10'));
        const { slots } = await resolveLatestIds(sql, q, userId, unrestrictedAccess());
        expect(slots.map((s) => s.id)).toEqual([movie, bNew, aOld]);
    });

    it('an episode in a denied library never moves its series up', async () => {
        const denied = (
            await sql<{ id: string }[]>`
                INSERT INTO library_groups (name, sort_order, created_at, updated_at)
                VALUES ('Denied', 1, NOW(), NOW()) RETURNING id`
        )[0].id;
        const movie = await item('Movie', 'movie', null, ago(2));
        const s = await item('A', 'tv', null);
        const s1 = await item('Season 1', 'season', s);
        const s2 = await item('Season 2', 'season', s);
        await item('A filler', 'episode', s1, ago(500));
        const visible = await item('A visible', 'episode', s1, ago(10));
        await item('A hidden', 'episode', s2, ago(1), denied);

        const q = parseLatestQuery(new URL('http://x/Items/Latest?Limit=10'));
        const access = restrictedAccess({
            deniedGroupIds: [denied],
            maxAgeRating: null,
            allowUnrated: true,
        });
        const { slots } = await resolveLatestIds(sql, q, userId, access);
        expect(slots.map((x) => x.id)).toEqual([movie, visible]);
    });

    it('a series whose only unwatched episode is older than the cutoff still fills the row', async () => {
        // A: newest file 1 h ago (watched); its newest unwatched episode is 100 h old.
        const [aOld, aNew] = await series('A', ago(100), ago(1));
        await watched(aNew);
        // B: newest file 2 h ago — the cutoff becomes 26 h ago, older than A's unwatched one.
        const [, bNew] = await series('B', ago(48), ago(2));

        const q = parseLatestQuery(new URL('http://x/Items/Latest?Limit=2'));
        const { slots } = await resolveLatestIds(sql, q, userId, unrestrictedAccess());
        expect(slots.map((s) => s.id)).toEqual([bNew, aOld]);
    });
});
