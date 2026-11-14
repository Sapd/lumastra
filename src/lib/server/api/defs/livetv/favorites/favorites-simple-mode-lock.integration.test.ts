// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The favorite write paths recheck the simple-mode lock inside their write
 * transaction. A lock that lands between the old outside check and the write
 * (here: a transaction that holds the simple-mode row lock while it sets the
 * lock) must refuse the change instead of slipping through.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import type { ApiContext } from '$lib/server/api/define.js';
import type { UserContext } from '$lib/server/types.js';
import { getTestDb } from '../../../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id';
import { createChannelWithMediaItem } from '$lib/server/database/queries/livetv-channels.queries.js';
import {
    lockSimpleModeRow,
    upsertSimpleModeRow,
} from '$lib/server/database/queries/livetv-simple-mode.queries.js';
import { setJellyfinFavorite } from '$lib/server/jellyfin-compat/favorites.js';

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

const { def: favoritesDef } = await import('./index.js');
const { def: orderDef } = await import('./order.js');

function user(id: string, username: string): UserContext {
    return {
        userId: toUserId(id),
        username,
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: true,
        hasRequestPermission: false,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
    } as UserContext;
}

function event(u: UserContext): RequestEvent {
    return { locals: { user: u }, params: {}, url: new URL('http://localhost/x') } as RequestEvent;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('favorites vs. a concurrent simple-mode lock', () => {
    let sql: postgres.Sql;
    let sourceId: string;

    beforeAll(() => {
        sql = getTestDb();
    });
    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE livetv_simple_mode, livetv_channel_favorites, livetv_channels, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
        sourceId = crypto.randomUUID();
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, max_streams)
            VALUES (${sourceId}::uuid, 'Test Source', 'm3u', 2)
        `;
    });

    async function channel(name: string): Promise<string> {
        const id = crypto.randomUUID();
        await createChannelWithMediaItem(sql, { id, name, streamUrl: 'http://s.test/x', sourceId });
        return id;
    }

    /**
     * Run `write` while another transaction holds the simple-mode row lock and
     * sets the lock; the write starts before that transaction commits.
     */
    async function writeDuringLock<T>(userId: string, write: () => Promise<T> | T): Promise<T> {
        let release!: () => void;
        const hold = new Promise<void>((r) => (release = r));
        const locker = sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as typeof sql;
            await lockSimpleModeRow(tx, userId);
            await upsertSimpleModeRow(tx, userId, {
                enabled: true,
                layout: 'tv',
                textSize: 'large',
                startChannelId: null,
                autostart: true,
                locked: true,
                pinHash: 'x',
                updatedBy: null,
            });
            await hold;
        });
        await sleep(150);
        const pending = Promise.resolve(write());
        await sleep(250);
        release();
        await locker;
        return pending;
    }

    const favoriteIds = async (userId: string): Promise<string[]> =>
        (
            await sql<{ channel_id: string }[]>`
                SELECT channel_id FROM livetv_channel_favorites WHERE user_id = ${userId}
            `
        ).map((r) => r.channel_id);

    it('PUT /livetv/favorites refuses a favorite when the lock lands first', async () => {
        const u = await createTestUser(sql);
        const a = await channel('Nordwelle');
        const res = await writeDuringLock(u.id, () =>
            favoritesDef.handlers.PUT!(event(user(u.id, u.username)), {
                surface: 'internal',
                input: { body: { stationId: a, favorite: true } },
            } as unknown as ApiContext),
        );
        expect(res.status).toBe(403);
        expect(await favoriteIds(u.id)).toEqual([]);
    });

    it('PUT /livetv/favorites/order refuses a reorder when the lock lands first', async () => {
        const u = await createTestUser(sql);
        const a = await channel('Nordwelle');
        const b = await channel('Kanal Sieben');
        await sql`
            INSERT INTO livetv_channel_favorites (user_id, channel_id, sort_order)
            VALUES (${u.id}, ${a}::uuid, 0), (${u.id}, ${b}::uuid, 1)
        `;
        const res = await writeDuringLock(u.id, () =>
            orderDef.handlers.PUT!(event(user(u.id, u.username)), {
                surface: 'internal',
                input: { body: { stationIds: [b, a] } },
            } as unknown as ApiContext),
        );
        expect(res.status).toBe(403);
        const rows = await sql<{ channel_id: string }[]>`
            SELECT channel_id FROM livetv_channel_favorites
             WHERE user_id = ${u.id} ORDER BY sort_order
        `;
        expect(rows.map((r) => r.channel_id)).toEqual([a, b]);
    });

    it('the Jellyfin favorite is a quiet no-op when the lock lands first', async () => {
        const u = await createTestUser(sql);
        const a = await channel('Nordwelle');
        const result = await writeDuringLock(u.id, () =>
            setJellyfinFavorite(sql, user(u.id, u.username), a, true),
        );
        expect(result).toEqual({ status: 'ok', target: 'channel' });
        expect(await favoriteIds(u.id)).toEqual([]);
    });

    it('without a lock the favorite is written', async () => {
        const u = await createTestUser(sql);
        const a = await channel('Nordwelle');
        const res = await favoritesDef.handlers.PUT!(event(user(u.id, u.username)), {
            surface: 'internal',
            input: { body: { stationId: a, favorite: true } },
        } as unknown as ApiContext);
        expect(res.status).toBe(200);
        expect(await favoriteIds(u.id)).toEqual([a]);
    });
});
