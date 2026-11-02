// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Typed Live TV failures end to end against real PostgreSQL and Valkey: the real provider with a
 * stubbed stream proxy client answers every reason as its problem+json, an app-side failure and
 * a success move the feed health, a failed heartbeat ends the session as `failed`, and
 * LIVETV_HIDE_OFFLINE_AFTER_FAILURES filters the viewer lineup.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id.js';
import { buildUserPermissions } from '$lib/server/auth.js';
import { bulkCreateChannels } from '$lib/server/database/queries/livetv-channels.queries.js';
import {
    recordFailure,
    listForChannels,
} from '$lib/server/database/queries/livetv-channel-health.queries.js';
import { connectValkey, getCoordinationClient } from '$lib/server/cache/valkey.js';
import { startPlayback } from './start-playback.js';
import { playbackKeepalive, playbackState } from './playback-session-lifecycle.js';
import { hideOfflineStations, invalidateHiddenStationsCache } from './channel-health.service.js';
import {
    LIVETV_FAILURE_POLICY,
    LIVETV_FAILURE_REASONS,
} from '../../../../shared/livetv-failure-reason.js';

const { overrides, proxy, validate } = vi.hoisted(() => ({
    overrides: {
        FEATURE_LIVETV: true,
        LIVETV_SOURCE: 'standalone',
        LIVETV_ADAPTIVE_LADDER_ENABLED: false,
        LIVETV_HIDE_OFFLINE_AFTER_FAILURES: 0,
    } as Record<string, unknown>,
    proxy: { joinChannel: vi.fn(), leaveChannel: vi.fn(), heartbeat: vi.fn() },
    validate: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../../tests/integration/setup/test-database.js');
    return { ...actual, getDb: () => getSql() };
});
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
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
vi.mock('./stream-proxy-client.js', () => ({ getStreamProxyClient: () => proxy }));
vi.mock('$lib/server/utils/url-validator.js', () => ({
    validateUrl: (...args: unknown[]) => validate(...args),
}));
vi.mock('./index.js', async () => {
    const { StandaloneLiveTvProvider } = await import('./standalone-livetv-provider.js');
    const provider = new StandaloneLiveTvProvider();
    return { getLiveTvProvider: async () => provider };
});

describe('typed Live TV failures', () => {
    let sql: postgres.Sql;
    let sourceId: string;
    let groupId: string;
    let shown: string;
    let other: string;
    let soloId: string;
    let user: Awaited<ReturnType<typeof createTestUser>>;
    let viewerKey: string;
    let credential: string;
    const sessionIds: string[] = [];

    function event(opts: { admin?: boolean; sessionId?: string } = {}): RequestEvent {
        return {
            locals: {
                user: {
                    userId: toUserId(user.id),
                    username: user.username,
                    groups: '',
                    userGroups: [],
                    ...buildUserPermissions([]),
                    hasLiveTvPermission: true,
                },
                principal: { isAdmin: opts.admin === true },
                liveTvCredentialId: credential,
            },
            getClientAddress: () => '127.0.0.1',
            params: opts.sessionId ? { playbackSessionId: opts.sessionId } : {},
            url: new URL('http://localhost/api/livetv/playback-sessions'),
            request: new Request('http://localhost/api/livetv/playback-sessions', {
                method: 'POST',
            }),
        } as unknown as RequestEvent;
    }
    async function health(id: string) {
        return (await listForChannels(sql, [id]))[0];
    }

    beforeAll(async () => {
        sql = getTestDb();
        expect(await connectValkey()).toBe(true);
    });
    beforeEach(async () => {
        vi.resetAllMocks();
        invalidateHiddenStationsCache();
        overrides.LIVETV_HIDE_OFFLINE_AFTER_FAILURES = 0;
        validate.mockResolvedValue({ valid: true });
        proxy.leaveChannel.mockResolvedValue({ success: true });
        await sql.unsafe(
            'TRUNCATE TABLE livetv_channel_health, livetv_channels, livetv_backup_groups, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
        sourceId = crypto.randomUUID();
        groupId = crypto.randomUUID();
        shown = crypto.randomUUID();
        other = crypto.randomUUID();
        soloId = crypto.randomUUID();
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, max_streams)
            VALUES (${sourceId}::uuid, 'Failure source', 'm3u', 2)
        `;
        await bulkCreateChannels(sql, {
            channels: [
                {
                    id: shown,
                    name: 'News FHD',
                    sortOrder: 0,
                    streamUrl: 'http://stream.test/shown',
                    sourceId,
                    backupGroupId: groupId,
                },
                {
                    id: other,
                    name: 'News HD',
                    sortOrder: 1,
                    streamUrl: 'http://stream.test/backup',
                    sourceId,
                    backupGroupId: groupId,
                },
                {
                    id: soloId,
                    name: 'Solo',
                    sortOrder: 2,
                    streamUrl: 'http://stream.test/solo',
                    sourceId,
                },
            ],
            categories: [],
            backupGroups: [{ id: groupId, name: 'News', sourceId, primaryChannelId: shown }],
        });
        await sql`UPDATE livetv_backup_groups SET primary_channel_id = ${shown} WHERE id = ${groupId}`;
        user = await createTestUser(sql);
        credential = `pat:${crypto.randomUUID()}`;
        viewerKey = `${user.username}:${credential}`;
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
        await closeTestDb();
    });

    describe('start path', () => {
        it.each(LIVETV_FAILURE_REASONS)(
            'a proxy channel_failed %s becomes its problem+json',
            async (reason) => {
                const policy = LIVETV_FAILURE_POLICY[reason];
                proxy.joinChannel.mockResolvedValue({
                    error: 'channel_failed',
                    reason,
                    retryable: policy.retryable,
                    ...(policy.retryAfterMs !== undefined
                        ? { retryAfterMs: policy.retryAfterMs }
                        : {}),
                    feedsTried: [{ index: 0, reason: 'channel_offline', upstreamStatus: 404 }],
                });
                const response = await startPlayback(event(), 'internal', { stationId: soloId });
                expect(response.status).toBe(policy.status);
                expect(response.headers.get('Content-Type')).toContain('application/problem+json');
                const body = await response.json();
                expect(body).toMatchObject({
                    code: reason,
                    failure: { retryable: policy.retryable },
                    status: policy.status,
                });
                expect(body.retryAfter).toBe(
                    policy.retryAfterMs === undefined
                        ? undefined
                        : Math.ceil(policy.retryAfterMs / 1000),
                );
                expect(response.headers.get('Retry-After')).toBe(
                    policy.retryAfterMs === undefined
                        ? null
                        : String(Math.ceil(policy.retryAfterMs / 1000)),
                );
                expect('feedsTried' in body.failure).toBe(false);
            },
        );

        it('names the failed feeds for administrators only', async () => {
            proxy.joinChannel.mockResolvedValue({
                error: 'channel_failed',
                reason: 'all_feeds_failed',
                retryable: false,
                feedsTried: [
                    {
                        index: 0,
                        feedId: shown,
                        reason: 'provider_auth_failed',
                        upstreamStatus: 401,
                    },
                    { index: 1, feedId: other, reason: 'channel_offline', upstreamStatus: 404 },
                ],
            });
            const asAdmin = await (
                await startPlayback(event({ admin: true }), 'internal', { stationId: groupId })
            ).json();
            expect(asAdmin.failure.feedsTried).toEqual([
                {
                    feedId: shown,
                    feedName: 'News FHD',
                    reason: 'provider_auth_failed',
                    upstreamStatus: 401,
                },
                {
                    feedId: other,
                    feedName: 'News HD',
                    reason: 'channel_offline',
                    upstreamStatus: 404,
                },
            ]);
            const asViewer = await (
                await startPlayback(event(), 'internal', { stationId: groupId })
            ).json();
            expect('feedsTried' in asViewer.failure).toBe(false);
        });

        it('sends the feed ids and the ready wait to the proxy', async () => {
            proxy.joinChannel.mockResolvedValue({ error: 'channel_failed', reason: 'no_video' });
            await startPlayback(event(), 'internal', { stationId: groupId });
            expect(proxy.joinChannel).toHaveBeenCalledWith(
                shown,
                expect.objectContaining({
                    feedIds: [shown, other],
                    awaitReadyMs: 12_000,
                    streamUrls: ['http://stream.test/shown', 'http://stream.test/backup'],
                }),
            );
        });

        it('answers spawn_failed as encoder_failed 500', async () => {
            proxy.joinChannel.mockResolvedValue({
                error: 'spawn_failed',
                message: 'ffmpeg missing',
                reason: 'encoder_failed',
            });
            const response = await startPlayback(event(), 'internal', { stationId: soloId });
            expect(response.status).toBe(500);
            expect(await response.json()).toMatchObject({
                code: 'encoder_failed',
                failure: { retryable: true },
                retryAfter: 5,
            });
        });

        it('answers an unreachable proxy as dependency_unavailable with a retry hint', async () => {
            proxy.joinChannel.mockRejectedValue(new Error('ECONNREFUSED'));
            const response = await startPlayback(event(), 'internal', { stationId: soloId });
            expect(response.status).toBe(503);
            expect(response.headers.get('Retry-After')).toBe('5');
            expect(await response.json()).toMatchObject({
                code: 'dependency_unavailable',
                failure: { retryable: true },
                retryAfter: 5,
            });
        });

        it('answers a station whose URLs are all blocked as provider_unreachable and counts it', async () => {
            validate.mockResolvedValue({ valid: false, reason: 'private address' });
            const response = await startPlayback(event(), 'internal', { stationId: groupId });
            expect(response.status).toBe(504);
            expect(await response.json()).toMatchObject({
                code: 'provider_unreachable',
                failure: { retryable: true },
                retryAfter: 10,
            });
            expect(proxy.joinChannel).not.toHaveBeenCalled();
            expect(await health(shown)).toMatchObject({
                consecutive_failures: 1,
                last_reason: 'provider_unreachable',
            });
            expect(await health(other)).toMatchObject({ consecutive_failures: 1 });
        });

        it('stream_limit keeps its details and gains the retry fields', async () => {
            proxy.joinChannel.mockResolvedValue({
                error: 'stream_limit_reached',
                limit: 2,
                active: [],
            });
            const response = await startPlayback(event(), 'internal', { stationId: soloId });
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({
                code: 'stream_limit',
                failure: { retryable: true },
                retryAfter: 30,
            });
        });

        it('an accepted start ends the failure streak of the shown feed', async () => {
            await recordFailure(sql, soloId, 'channel_offline');
            await recordFailure(sql, soloId, 'channel_offline');
            proxy.joinChannel.mockResolvedValue({ success: true, channelId: soloId, ready: true });
            const response = await startPlayback(event(), 'internal', { stationId: soloId });
            expect(response.status).toBe(201);
            sessionIds.push((await response.json()).playbackSessionId);
            expect(await health(soloId)).toMatchObject({ consecutive_failures: 0 });
        });

        it('an admitted start that is not ready (or from a proxy without ready) keeps the streak', async () => {
            await recordFailure(sql, soloId, 'channel_offline');
            for (const answer of [
                { success: true, channelId: soloId },
                { success: true, channelId: soloId, ready: false },
            ]) {
                proxy.joinChannel.mockResolvedValue(answer);
                const response = await startPlayback(event(), 'internal', { stationId: soloId });
                expect(response.status).toBe(201);
                sessionIds.push((await response.json()).playbackSessionId);
            }
            expect(await health(soloId)).toMatchObject({ consecutive_failures: 1 });
        });

        it('a hover preview neither waits for the first segment nor ends the streak', async () => {
            await recordFailure(sql, soloId, 'channel_offline');
            proxy.joinChannel.mockResolvedValue({ success: true, channelId: soloId, ready: true });
            const response = await startPlayback(event(), 'internal', {
                stationId: soloId,
                purpose: 'preview',
            });
            expect(response.status).toBe(201);
            sessionIds.push((await response.json()).playbackSessionId);
            expect(proxy.joinChannel.mock.calls[0][1]).not.toHaveProperty('awaitReadyMs');
            expect(await health(soloId)).toMatchObject({ consecutive_failures: 1 });
        });
    });

    describe('mid-stream failure', () => {
        it('ends the session as failed on the first failed heartbeat and answers the same 410 after', async () => {
            proxy.joinChannel.mockResolvedValue({ success: true, channelId: soloId });
            const started = await startPlayback(event(), 'internal', { stationId: soloId });
            expect(started.status).toBe(201);
            const { playbackSessionId: sessionId } = await started.json();
            sessionIds.push(sessionId);

            proxy.heartbeat.mockResolvedValue({
                success: false,
                message: 'channel failed',
                failure: {
                    reason: 'upstream_stalled',
                    retryAfterMs: 3000,
                    feedsTried: [{ index: 0, feedId: soloId, reason: 'upstream_stalled' }],
                },
            });
            const first = await playbackKeepalive(event({ sessionId }));
            expect(first.status).toBe(410);
            expect(first.headers.get('Retry-After')).toBe('3');
            const firstBody = await first.json();
            expect(firstBody).toMatchObject({
                code: 'upstream_stalled',
                error: 'playback_session_ended',
                reason: 'failed',
                failure: { retryable: true },
                retryAfter: 3,
            });
            expect('feedsTried' in firstBody.failure).toBe(false);
            expect(proxy.leaveChannel).toHaveBeenCalledWith(
                soloId,
                viewerKey,
                expect.any(AbortSignal),
            );

            proxy.heartbeat.mockClear();
            const again = await playbackKeepalive(event({ sessionId }));
            expect(again.status).toBe(410);
            expect(await again.json()).toMatchObject({
                code: 'upstream_stalled',
                reason: 'failed',
            });
            expect(proxy.heartbeat).not.toHaveBeenCalled();

            const adminView = await (
                await playbackKeepalive(event({ sessionId, admin: true }))
            ).json();
            // Names come from the feeds stored on the session at start, never from the proxy.
            expect(adminView.failure.feedsTried).toEqual([
                { feedId: soloId, feedName: 'Solo', reason: 'upstream_stalled' },
            ]);

            const state = await (await playbackState(event({ sessionId }))).json();
            expect(state).toMatchObject({
                state: 'ended',
                endReason: 'failed',
                failure: { code: 'upstream_stalled', retryable: true, retryAfterMs: 3000 },
            });
            expect(typeof state.failure.at).toBe('string');
        });
    });

    describe('LIVETV_HIDE_OFFLINE_AFTER_FAILURES', () => {
        const feeds = (): Array<{ id: string; backupGroupId?: string }> => [
            { id: shown, backupGroupId: groupId },
            { id: soloId },
        ];
        const failN = async (id: string, n: number): Promise<void> => {
            for (let i = 0; i < n; i++) await recordFailure(sql, id, 'channel_offline');
            // These writes bypass the service, which would drop the cached hidden set itself.
            invalidateHiddenStationsCache();
        };

        it('shows everything while the setting is off', async () => {
            await failN(soloId, 9);
            expect(await hideOfflineStations(feeds(), event().locals)).toHaveLength(2);
        });

        it('hides a station whose every feed failed N times, and only for viewers', async () => {
            overrides.LIVETV_HIDE_OFFLINE_AFTER_FAILURES = 3;
            await failN(soloId, 3);
            await failN(shown, 3);
            expect((await hideOfflineStations(feeds(), event().locals)).map((c) => c.id)).toEqual([
                shown,
            ]);
            // The group keeps its second feed untested, so it stays visible.
            await failN(other, 2);
            expect((await hideOfflineStations(feeds(), event().locals)).map((c) => c.id)).toEqual([
                shown,
            ]);
            await failN(other, 1);
            expect(await hideOfflineStations(feeds(), event().locals)).toEqual([]);
            expect(await hideOfflineStations(feeds(), event({ admin: true }).locals)).toHaveLength(
                2,
            );
        });

        it('lets a station reappear once its last failure is older than six hours', async () => {
            overrides.LIVETV_HIDE_OFFLINE_AFTER_FAILURES = 3;
            await failN(soloId, 5);
            await sql`UPDATE livetv_channel_health SET last_failure_at = now() - interval '7 hours'
                      WHERE channel_id = ${soloId}`;
            expect(
                (await hideOfflineStations([{ id: soloId }], event().locals)).map((c) => c.id),
            ).toEqual([soloId]);
        });
    });
});
