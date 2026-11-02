// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Stable station ids at the API boundary; feed FKs in PostgreSQL and real Valkey handles. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import type { LiveTvStreamInfo } from '$lib/schemas/livetv.js';
import { PlaybackSessionStartResponseSchema } from '$lib/schemas/livetv-playback-sessions.js';
import type { ApiContext } from '$lib/server/api/define.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id.js';
import { buildUserPermissions } from '$lib/server/auth.js';
import {
    bulkCreateChannels,
    resolveStation,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import {
    connectValkey,
    disconnectValkey,
    getCoordinationClient,
} from '$lib/server/cache/valkey.js';
import { getSimpleMode, updateSimpleMode } from './simple-mode.service.js';
import { getLiveTvSessionService } from './livetv-session.service.js';
import { startPlayback } from './start-playback.js';
import { def as favorites } from '$lib/server/api/defs/livetv/favorites/index.js';
import { def as order } from '$lib/server/api/defs/livetv/favorites/order.js';

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../../tests/integration/setup/test-database.js');
    return { ...actual, getDb: () => getSql() };
});

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    const overrides: Record<string, unknown> = {
        FEATURE_LIVETV: true,
        LIVETV_SOURCE: 'standalone',
        LIVETV_ADAPTIVE_LADDER_ENABLED: false,
    };
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get: (target, key, receiver) =>
                typeof key === 'string' && key in overrides
                    ? overrides[key]
                    : Reflect.get(target, key, receiver),
        }),
    };
});

const { provider, proxy } = vi.hoisted(() => ({
    provider: { getStreamInfo: vi.fn() },
    proxy: { leaveChannel: vi.fn(), heartbeat: vi.fn() },
}));
vi.mock('./index.js', () => ({ getLiveTvProvider: async () => provider }));
vi.mock('./stream-proxy-client.js', () => ({ getStreamProxyClient: () => proxy }));

function context(body?: unknown): ApiContext {
    return { surface: 'internal', input: { body } } as unknown as ApiContext;
}

describe('grouped stations across favorites, simple mode and playback', () => {
    let sql: postgres.Sql;
    let sourceId: string;
    let groupId: string;
    let shown: string;
    let other: string;
    let user: Awaited<ReturnType<typeof createTestUser>>;
    let requestEvent: RequestEvent;
    let viewerKey: string;
    const sessionIds: string[] = [];

    beforeAll(async () => {
        sql = getTestDb();
        expect(await connectValkey()).toBe(true);
    });
    beforeEach(async () => {
        vi.clearAllMocks();
        await sql.unsafe(
            'TRUNCATE TABLE livetv_simple_mode, livetv_channel_favorites, livetv_channels, livetv_backup_groups, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
        sourceId = crypto.randomUUID();
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, max_streams)
            VALUES (${sourceId}::uuid, 'Grouped station source', 'm3u', 2)
        `;
        ({ groupId, shown, other } = await group('News'));
        expect(groupId).not.toBe(shown);
        expect(await resolveStation(sql, groupId)).toEqual({
            stationId: groupId,
            shownFeedId: shown,
            groupId,
        });
        user = await createTestUser(sql);
        const credential = `pat:${crypto.randomUUID()}`;
        viewerKey = `${user.username}:${credential}`;
        requestEvent = {
            locals: {
                user: {
                    userId: toUserId(user.id),
                    username: user.username,
                    groups: '',
                    userGroups: [],
                    ...buildUserPermissions([]),
                    hasLiveTvPermission: true,
                },
                liveTvCredentialId: credential,
            },
            getClientAddress: () => '127.0.0.1',
            params: {},
            url: new URL('http://localhost/api/livetv/playback-sessions'),
            request: new Request('http://localhost/api/livetv/playback-sessions', {
                method: 'POST',
            }),
        } as unknown as RequestEvent;
        provider.getStreamInfo.mockImplementation(
            async (feedId: string): Promise<LiveTvStreamInfo> => ({
                streamUrl: `/api/livetv/channels/${feedId}/stream/master.m3u8`,
                requiresProxy: true,
                sourceId,
                maxStreams: 2,
                rungId: null,
                requestedMaxBitrateBps: null,
                appliedMaxBitrateBps: null,
                appliedMaxHeight: null,
                reason: null,
            }),
        );
    });
    afterEach(async () => {
        const client = getCoordinationClient();
        if (client) {
            await client.del([
                ...sessionIds.map((id) => `livetv:v2:psess:${id}`),
                `livetv:v2:viewer-psess:${viewerKey}`,
                `livetv:v2:psess-lock:${viewerKey}`,
                `livetv:v2:session:${viewerKey}`,
                `livetv:v2:kicked:${viewerKey}`,
                `livetv:v2:source:${sourceId}:sessions`,
            ]);
        }
        sessionIds.length = 0;
    });
    afterAll(async () => {
        await disconnectValkey();
        await closeTestDb();
    });

    async function group(name: string): Promise<{ groupId: string; shown: string; other: string }> {
        const groupId = crypto.randomUUID();
        const shown = crypto.randomUUID();
        const other = crypto.randomUUID();
        await bulkCreateChannels(sql, {
            channels: [
                {
                    id: shown,
                    name: `${name} FHD`,
                    qualityTier: 'fhd',
                    sortOrder: 0,
                    streamUrl: 'http://stream.test/shown',
                    sourceId,
                    backupGroupId: groupId,
                },
                {
                    id: other,
                    name: `${name} HD`,
                    qualityTier: 'hd',
                    sortOrder: 1,
                    streamUrl: 'http://stream.test/backup',
                    sourceId,
                    backupGroupId: groupId,
                },
            ],
            categories: [],
            backupGroups: [{ id: groupId, name, sourceId, primaryChannelId: shown }],
        });
        await sql`UPDATE livetv_backup_groups SET primary_channel_id = ${shown} WHERE id = ${groupId}`;
        return { groupId, shown, other };
    }
    async function savedFeeds(): Promise<string[]> {
        const rows = await sql<{ channel_id: string }[]>`
            SELECT channel_id FROM livetv_channel_favorites
             WHERE user_id = ${user.id} ORDER BY sort_order, channel_id
        `;
        return rows.map((row) => row.channel_id);
    }
    async function save(feedId: string, sort = 0): Promise<void> {
        await sql`
            INSERT INTO livetv_channel_favorites (user_id, channel_id, sort_order)
            VALUES (${user.id}, ${feedId}::uuid, ${sort})
        `;
    }
    async function putFavorite(favorite: boolean): Promise<Response> {
        return favorites.handlers.PUT!(requestEvent, context({ stationId: groupId, favorite }));
    }

    it('favorites PUT stores the shown feed and GET returns the group id', async () => {
        const response = await putFavorite(true);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ stationIds: [groupId] });
        expect(await savedFeeds()).toEqual([shown]);
        const read = await favorites.handlers.GET!(requestEvent, context());
        expect(read.status).toBe(200);
        expect(await read.json()).toEqual({ stationIds: [groupId] });
    });

    it('removes a favorite stored under the non-shown member', async () => {
        await save(other);
        const response = await putFavorite(false);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ stationIds: [] });
        expect(await savedFeeds()).toEqual([]);
    });

    it('removes saved members even when all feeds are hidden and the station cannot resolve', async () => {
        await save(other);
        await save(shown, 1);
        await sql`UPDATE livetv_channels SET is_visible = false WHERE backup_group_id = ${groupId}`;
        expect(await resolveStation(sql, groupId)).toBeNull();
        const response = await putFavorite(false);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ stationIds: [] });
        expect(await savedFeeds()).toEqual([]);
    });

    it('does not add a row when another member of the station is already saved', async () => {
        await save(other);
        const response = await putFavorite(true);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ stationIds: [groupId] });
        expect(await savedFeeds()).toEqual([other]);
    });

    it('reorders stored favorite rows using group ids, including a non-shown representative', async () => {
        const second = await group('Sports');
        await save(other, 0);
        await save(second.shown, 1);
        const response = await order.handlers.PUT!(
            requestEvent,
            context({
                stationIds: [second.groupId, groupId],
            }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ stationIds: [second.groupId, groupId] });
        expect(await savedFeeds()).toEqual([second.shown, other]);
        const read = await favorites.handlers.GET!(requestEvent, context());
        expect(await read.json()).toEqual({ stationIds: [second.groupId, groupId] });
    });

    it('simple mode round-trips the group id and stores the shown feed', async () => {
        const userId = toUserId(user.id);
        const result = await updateSimpleMode(
            sql,
            userId,
            {
                enabled: true,
                stationIds: [groupId],
                startStationId: groupId,
            },
            { actorUserId: userId, asAdmin: false },
        );
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('Expected simple mode update to succeed');
        expect(result.value.stationIds).toEqual([groupId]);
        expect(result.value.startStationId).toBe(groupId);
        expect(await getSimpleMode(sql, userId)).toMatchObject({
            stationIds: [groupId],
            startStationId: groupId,
        });
        expect(await savedFeeds()).toEqual([shown]);
        const [row] = await sql<{ start_channel_id: string }[]>`
            SELECT start_channel_id FROM livetv_simple_mode WHERE user_id = ${user.id}
        `;
        expect(row.start_channel_id).toBe(shown);
    });

    it('starts playback for the shown feed while keeping the group as station identity', async () => {
        const response = await startPlayback(requestEvent, 'internal', { stationId: groupId });
        expect(response.status).toBe(201);
        const body = PlaybackSessionStartResponseSchema.parse(await response.json());
        sessionIds.push(body.playbackSessionId);
        expect(body).toMatchObject({
            stationId: groupId,
            delivery: { feedId: shown, requestedMaxBitrateBps: null, appliedMaxBitrateBps: null },
        });
        expect(provider.getStreamInfo).toHaveBeenCalledWith(
            shown,
            viewerKey,
            undefined,
            undefined,
            undefined,
            expect.objectContaining({ awaitReady: true }),
        );
        expect(
            await getLiveTvSessionService().getPlaybackSession(body.playbackSessionId),
        ).toMatchObject({
            stationId: groupId,
            feedId: shown,
            state: 'active',
            viewerKey,
        });
    });

    it('rejects an explicit feed from another group before contacting the provider', async () => {
        const second = await group('Sports');
        const response = await startPlayback(requestEvent, 'internal', {
            stationId: groupId,
            feedId: second.shown,
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ reason: 'feed_not_found' });
        expect(provider.getStreamInfo).not.toHaveBeenCalled();
        expect(await getLiveTvSessionService().getViewerPlaybackSession(viewerKey)).toBeNull();
    });

    it('a hover preview is its own viewer: it never supersedes the real playback session', async () => {
        const real = await startPlayback(requestEvent, 'internal', { stationId: groupId });
        expect(real.status).toBe(201);
        const realBody = await real.json();
        sessionIds.push(realBody.playbackSessionId);

        const preview = await startPlayback(requestEvent, 'internal', {
            stationId: groupId,
            feedId: other,
            purpose: 'preview',
        });
        expect(preview.status).toBe(201);
        const previewBody = await preview.json();
        sessionIds.push(previewBody.playbackSessionId);
        expect(previewBody.purpose).toBe('preview');
        expect(previewBody.delivery.url).toContain('preview=1');
        expect(provider.getStreamInfo).toHaveBeenLastCalledWith(
            other,
            `${viewerKey}:preview`,
            undefined,
            undefined,
            undefined,
            // A preview never waits for the first segment and never counts as feed health.
            expect.objectContaining({ awaitReady: false }),
        );

        const service = getLiveTvSessionService();
        expect(await service.getPlaybackSession(realBody.playbackSessionId)).toMatchObject({
            state: 'active',
            viewerKey,
        });
        expect(await service.getPlaybackSession(previewBody.playbackSessionId)).toMatchObject({
            state: 'active',
            kind: 'preview',
            viewerKey: `${viewerKey}:preview`,
        });
        // The preview is not a watch.
        const history = await sql<{ channel_id: string }[]>`
            SELECT channel_id FROM livetv_channel_watch_history WHERE user_id = ${user.id}
        `;
        expect(history.map((row) => row.channel_id)).not.toContain(other);
    });
});
