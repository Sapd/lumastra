// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { withTx } from '../with-tx.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { UserContext } from '../../types.js';
import * as connection from '../connection.js';
import { aiDbService } from '../../services/database.service.js';
import { config } from '../../config.js';
import { mount } from '../../api/mount.js';
import { def as watchlist } from '../../api/defs/watchlist/index.js';
import { def as detail } from '../../api/defs/catalog/media-id.js';
import { def as legacyDetail } from '../../api/defs/media/details.js';
import { def as batch } from '../../api/defs/catalog/media-batch.js';
import { checkMediaAccess, checkMediaAccessBatch } from '../../middleware/media-access.js';
import { upsertWatchlistItem } from './watchlist.queries.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
    invalidateLibraryGroupPermissionsCache,
} from '../../cache/library-group-permissions-cache.js';
import { CatalogService } from '../../services/catalog.service.js';
import { GET as cover } from '../../../../routes/api/image/audiobook/[id]/+server.js';
import { getUserWatchlistMedia } from './watchlist-media.queries.js';

vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSet: async () => ({}),
    resolveImageSets: async () => new Map(),
}));

vi.mock('$lib/server/services/image-proxy', () => ({
    getImageProxyService: () => ({
        getAudiobookImage: async () => ({
            buffer: Buffer.from('cover'),
            contentType: 'image/jpeg',
        }),
    }),
    imageResponse: () => new Response('cover'),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    withImageProxyRateLimit: (handler: unknown) => handler,
}));

let db: postgres.Sql;
const rollback = new Error('rollback security fixtures');
beforeAll(() => {
    db = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});

function event(path: string, user: UserContext, mediaId: string, body?: unknown): RequestEvent {
    const url = new URL('http://localhost/api/v1' + path);
    return {
        url,
        request: new Request(
            url,
            body === undefined
                ? undefined
                : {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify(body),
                  },
        ),
        params: { id: mediaId },
        locals: { user, resolvedIds: { internalId: mediaId } },
        route: { id: '/api/v1/media/[id]' },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
        cookies: {},
        fetch,
    } as unknown as RequestEvent;
}

async function fixture(
    run: (sql: postgres.Sql, id: string, groupId: string, user: UserContext) => Promise<void>,
): Promise<void> {
    await withTx(db, async (sql) => {
        invalidateLibraryGroupPermissionsCache();
        vi.spyOn(connection, 'getDb').mockReturnValue(sql);
        vi.spyOn(aiDbService, 'getSql').mockResolvedValue(sql);
        vi.spyOn(config, 'UNRATED_CONTENT_VISIBLE', 'get').mockReturnValue(true);
        // Channel identity on file-backed reads is only checked while Live TV is enabled.
        vi.spyOn(config, 'FEATURE_LIVETV', 'get').mockReturnValue(true);
        const user: UserContext = {
            userId: toUserId(randomUUID()),
            username: 'abs-followup-' + randomUUID(),
            groups: '',
            userGroups: [],
            ownerIsAdmin: false,
            mediaAccessIsAdmin: false,
            hasWatchPermission: true,
            hasLiveTvPermission: false,
            hasRequestPermission: false,
            maxAgeRating: 12,
            isAgeRestricted: true,
            isModerator: false,
            liveTvPriority: 'low',
        };
        await ensureTestUser(sql, user.userId);
        const id = randomUUID(),
            groupId = randomUUID();
        await sql`INSERT INTO library_groups (id, name, max_age_rating)
            VALUES (${groupId}, 'Untrusted / Audiobooks 🎧', 18)`;
        await sql`INSERT INTO media_items (id, title, media_type, status, has_files, library_group_id, custom_metadata)
            VALUES (${id}, 'The Followup Lantern', 'audiobook', 'active', true, ${groupId},
                ${sql.json({ audiobookshelf: { duration: 120, chapters: [], authors: [], narrators: [], series: [] } })})`;
        try {
            await run(sql, id, groupId, user);
        } finally {
            vi.restoreAllMocks();
            invalidateLibraryGroupPermissionsCache();
        }
        throw rollback;
    }).catch((error: unknown) => {
        if (error !== rollback) throw error;
    });
}

describe('audiobook security follow-up (real DB + mounted handlers)', () => {
    it.each(['age', 'library', 'dismissed', 'unavailable'] as const)(
        'gates a real ABS-id cover by %s before serving bytes',
        async (reason) => {
            await fixture(async (sql, id, group, kid) => {
                const absId = 'cover-' + randomUUID();
                await new CatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(
                    id,
                    {
                        provider: 'audiobookshelf',
                        id: absId,
                        mediaType: 'audiobook',
                        source: 'audiobookshelf',
                    },
                    true,
                );
                const request = (user: UserContext) =>
                    cover(
                        event('/image/audiobook/' + absId, user, absId) as Parameters<
                            typeof cover
                        >[0],
                    );
                const normal = { ...kid, isAgeRestricted: false, maxAgeRating: null };
                const admitted = await request(normal);
                expect(admitted.status).toBe(200);
                expect(admitted.headers.get('cache-control')).toBe('private, no-cache');
                if (reason === 'library') {
                    await sql`INSERT INTO library_group_permissions (library_group_id, allowed_groups) VALUES (${group}, ${['adult-only']})`;
                    invalidateLibraryGroupPermissionsCache();
                } else if (reason === 'dismissed') {
                    await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${id}`;
                } else if (reason === 'unavailable') {
                    await sql`UPDATE media_items SET has_files = false WHERE id = ${id}`;
                }
                expect((await request(reason === 'age' ? kid : normal)).status).toBe(404);
                expect(
                    (await request({ ...normal, ownerIsAdmin: true, mediaAccessIsAdmin: true }))
                        .status,
                ).toBe(200);
            });
        },
    );

    it.each([
        { withRestrictions: false, hasLiveTvPermission: false },
        { withRestrictions: true, hasLiveTvPermission: false },
        { withRestrictions: false, hasLiveTvPermission: true },
        { withRestrictions: true, hasLiveTvPermission: true },
    ])(
        'combines an audiobook age and availability check into one content read (library restrictions: $withRestrictions, Live TV: $hasLiveTvPermission)',
        async ({ withRestrictions, hasLiveTvPermission }) => {
            await fixture(async (sql, id, _groupId, kid) => {
                // This query budget depends on global permission configuration, not
                // just this book's rows. The fixture rolls these changes back.
                await sql`DELETE FROM library_group_permissions`;
                if (withRestrictions) {
                    const unrelatedGroup = randomUUID();
                    await sql`INSERT INTO library_groups (id, name)
                        VALUES (${unrelatedGroup}, 'Read count restricted library')`;
                    await sql`INSERT INTO library_group_permissions (library_group_id, allowed_groups)
                        VALUES (${unrelatedGroup}, ${['other-readers']})`;
                }
                invalidateLibraryGroupPermissionsCache();
                await getDeniedLibraryGroups(sql, toLibraryAccessUser(kid));
                const reads: string[] = [];
                const counted = new Proxy(sql, {
                    apply(target, thisArg, args) {
                        const parts: unknown = args[0];
                        if (
                            Array.isArray(parts) &&
                            typeof parts[0] === 'string' &&
                            /^\s*SELECT/.test(parts[0])
                        )
                            reads.push(parts.join(''));
                        return Reflect.apply(target, thisArg, args);
                    },
                });
                expect(await checkMediaAccess(counted, id, { ...kid, hasLiveTvPermission })).toBe(
                    false,
                );
                // Configured restrictions need one separate library-access probe;
                // age and live audiobook availability still share exactly one read.
                // Live TV identity shares that read, even when viewing is denied.
                expect(reads).toHaveLength(1 + Number(withRestrictions));
                expect(
                    reads.filter(
                        (query) =>
                            query.includes('AS age_rating') && query.includes('AS is_live_tv'),
                    ),
                ).toHaveLength(1);
                expect(reads.filter((query) => query.includes('AS age_rating'))).toHaveLength(1);
            });
        },
    );

    it.each(['channel-table', 'catalog-only'] as const)(
        'denies a Live TV item from %s through the combined read, including with warm caches',
        async (identity) => {
            await fixture(async (sql, _id, _groupId, kid) => {
                await sql`DELETE FROM library_group_permissions`;
                invalidateLibraryGroupPermissionsCache();
                await getDeniedLibraryGroups(sql, toLibraryAccessUser(kid));
                const channelId = randomUUID();
                await sql`INSERT INTO media_items (id, title, media_type, age_rating)
                    VALUES (${channelId}, 'Combined read channel', ${identity === 'catalog-only' ? 'tvchannel' : 'movie'}, 6)`;
                if (identity === 'channel-table') {
                    await sql`INSERT INTO livetv_channels (id, m3u_url)
                        VALUES (${channelId}, 'https://example.invalid/channel')`;
                }
                // Warm the age cache as an allowed viewer first. Denied viewers
                // must still re-read identity, including on file-backed routes.
                expect(
                    await checkMediaAccess(sql, channelId, { ...kid, hasLiveTvPermission: true }),
                ).toBe(true);
                const reads: string[] = [];
                const counted = new Proxy(sql, {
                    apply(target, thisArg, args) {
                        const parts: unknown = args[0];
                        if (Array.isArray(parts) && /^\s*SELECT/.test(String(parts[0])))
                            reads.push(parts.join(''));
                        return Reflect.apply(target, thisArg, args);
                    },
                });
                for (const user of [
                    kid,
                    { ...kid, isAgeRestricted: false, maxAgeRating: null },
                    {
                        ...kid,
                        isAgeRestricted: false,
                        ownerIsAdmin: true,
                        mediaAccessIsAdmin: true,
                    },
                ]) {
                    reads.length = 0;
                    expect(
                        await checkMediaAccess(counted, channelId, user, { fileBacked: true }),
                    ).toBe(false);
                    expect(reads).toHaveLength(1);
                    expect(reads[0]).toContain('AS age_rating');
                    expect(reads[0]).toContain('AS is_live_tv');
                }
            });
        },
    );

    it.each([false, true])(
        'gates a Live TV channel without any media row by Live TV permission (age-restricted: %s)',
        async (isAgeRestricted) => {
            await fixture(async (sql, _id, _groupId, kid) => {
                await sql`DELETE FROM library_group_permissions`;
                invalidateLibraryGroupPermissionsCache();
                const channelId = randomUUID();
                // The FK normally prevents orphan channels. Remove it only
                // inside this rolled-back fixture to exercise defensive gating.
                await sql`ALTER TABLE livetv_channels DROP CONSTRAINT livetv_channels_id_fkey`;
                const channels = await sql`INSERT INTO livetv_channels (id, m3u_url)
                    VALUES (${channelId}, 'https://example.invalid/channel-without-media')
                    RETURNING id`;
                expect(channels).toEqual([{ id: channelId }]);
                expect(await sql`SELECT id FROM media_items WHERE id = ${channelId}`).toHaveLength(
                    0,
                );
                const user = {
                    ...kid,
                    isAgeRestricted,
                    maxAgeRating: isAgeRestricted ? 12 : null,
                };
                // The allowed viewer also warms the age cache; identity must
                // still be read for the viewer without Live TV permission.
                expect(
                    await checkMediaAccess(sql, channelId, { ...user, hasLiveTvPermission: true }),
                ).toBe(true);
                expect(
                    await checkMediaAccess(sql, channelId, { ...user, hasLiveTvPermission: false }),
                ).toBe(false);
            });
        },
    );

    it('preserves unknown-UUID gate semantics while the individual route returns 404', async () => {
        await fixture(async (sql, _id, _groupId, kid) => {
            const user = { ...kid, maxAgeRating: null, isAgeRestricted: false };
            const unknownId = randomUUID();
            expect(await checkMediaAccess(sql, unknownId, user)).toBe(true);
            expect(await checkMediaAccessBatch(sql, [unknownId], user)).toEqual(
                new Set([unknownId]),
            );
            expect(
                (
                    await mount(detail, { surface: 'v1' }).GET!(
                        event('/media/' + unknownId, user, unknownId),
                    )
                ).status,
            ).toBe(404);
        });
    });

    it('preserves watchlist metadata override and aggregated-provider precedence', async () => {
        await fixture(async (sql, id, _groupId, user) => {
            await upsertWatchlistItem(sql, user.userId, id);
            // The preferred-provider trigger requires an enabled capability row.
            await sql`INSERT INTO provider_capabilities (provider, enabled, priority)
                VALUES ('tmdb', true, 1) ON CONFLICT (provider) DO UPDATE SET enabled = true`;
            await sql`INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${id}, 'aggregated', ${sql.json({ overview: 'Aggregated overview' })}, now()),
                       (${id}, 'tmdb', ${sql.json({ overview: 'Override overview' })}, now())`;
            const access = { deniedGroupIds: null, ageRating: null };
            expect((await getUserWatchlistMedia(sql, user.userId, access))[0].overview).toBe(
                'Aggregated overview',
            );
            await sql`UPDATE media_items SET preferred_provider = 'tmdb' WHERE id = ${id}`;
            expect((await getUserWatchlistMedia(sql, user.userId, access))[0].overview).toBe(
                'Override overview',
            );
        });
    });
    it('GET /watchlist hides an unrated book in an 18-rated library from a kid', async () => {
        await fixture(async (sql, id, _groupId, user) => {
            await upsertWatchlistItem(sql, user.userId, id);
            const response = await mount(watchlist, { surface: 'v1' }).GET!(
                event('/watchlist', user, id),
            );
            expect(response.status).toBe(200);
            expect((await response.json()).items).toEqual([]);
            expect(
                (await sql`SELECT media_id FROM playlist_items WHERE media_id = ${id}`).length,
            ).toBe(1);
        });
    });

    it('a group rated 12 supplies the missing book rating when a 12-year-old hides unrated content', async () => {
        await fixture(async (sql, id, groupId, user) => {
            vi.spyOn(config, 'UNRATED_CONTENT_VISIBLE', 'get').mockReturnValue(false);
            await sql`UPDATE library_groups SET max_age_rating = 12 WHERE id = ${groupId}`;
            await upsertWatchlistItem(sql, user.userId, id);
            expect(await checkMediaAccess(sql, id, user)).toBe(true);
            const response = await mount(watchlist, { surface: 'v1' }).GET!(
                event('/watchlist', user, id),
            );
            expect(response.status).toBe(200);
            expect((await response.json()).items.map((item: { id: string }) => item.id)).toEqual([
                id,
            ]);
        });
    });

    it.each(['dismissed', 'unavailable'] as const)(
        'denies %s books through single/batch gates and detail/by-id handlers',
        async (retirement) => {
            await fixture(async (sql, id, _groupId, kid) => {
                const user = { ...kid, maxAgeRating: null, isAgeRestricted: false };
                const admin = { ...user, ownerIsAdmin: true, mediaAccessIsAdmin: true };
                const routes = [
                    { get: mount(detail, { surface: 'v1' }).GET!, path: '/media/' + id },
                    {
                        get: mount(legacyDetail, { surface: 'v1' }).GET!,
                        path: '/media/details?key=' + id,
                    },
                ];
                for (const route of routes) {
                    const response = await route.get(event(route.path, user, id));
                    expect(response.status, route.path + ' active control').toBe(200);
                }
                await sql`UPDATE media_items SET
                is_dismissed = ${retirement === 'dismissed'}, has_files = ${retirement !== 'unavailable'}
                WHERE id = ${id}`;
                expect(await checkMediaAccess(sql, id, user)).toBe(false);
                expect(await checkMediaAccessBatch(sql, [id], user)).toEqual(new Set());
                expect(await checkMediaAccess(sql, id, admin)).toBe(true);
                expect(
                    await checkMediaAccess(sql, id, { ...admin, mediaAccessIsAdmin: false }),
                ).toBe(false);
                for (const route of routes) {
                    const response = await route.get(event(route.path, user, id));
                    expect(response.status, route.path).toBe(404);
                    expect(await response.text()).not.toContain('The Followup Lantern');
                    const inspection = await route.get(event(route.path, admin, id));
                    expect(inspection.status, route.path + ' admin inspection').toBe(200);
                }
            });
        },
    );

    it.each(['preview', 'detail'] as const)(
        'POST /media/batch omits retired books in %s mode',
        async (include) => {
            await fixture(async (sql, id, _groupId, kid) => {
                const user = { ...kid, maxAgeRating: null, isAgeRestricted: false };
                const post = mount(batch, { surface: 'v1' }).POST!;
                const control = await post(event('/media/batch', user, id, { ids: [id], include }));
                expect(control.status).toBe(200);
                expect((await control.json()).items).toHaveLength(1);
                await sql`UPDATE media_items SET has_files = false, is_dismissed = true WHERE id = ${id}`;
                const response = await post(
                    event('/media/batch', user, id, { ids: [id], include }),
                );
                expect(response.status).toBe(200);
                expect(await response.json()).toEqual({ items: [], missing: [id] });
            });
        },
    );
});
