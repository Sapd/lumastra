// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../tests/integration/setup/test-database';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/user.fixtures';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../tests/integration/fixtures/media.fixtures';
import { cancellationDef } from '$lib/server/api/defs/play-sessions/_cancellation.js';
import { config } from '../config';
import {
    claimStaleSessionsForUser,
    getLiveJellyfinCompatSessions,
} from '../database/queries/play-sessions.queries';
import { toUserId } from '$lib/shared/user-id';
import {
    getPlaybackGrant,
    mintPlaybackGrant,
    renewPlaybackGrant,
    revokePlaybackGrant,
    revokeGrantsForPlaySession,
    revokeLiveGrantsForUser,
    validatePlaybackGrant as validateGrant,
    invalidatePlaybackGrantCache,
    resolvePlaybackGrantRoute,
} from './playback-grant';

import {
    addPreviewSession,
    buildPreviewStreamHref,
    cleanupPreviewSession,
    type PreviewSession,
} from './preview-session.service';

const liveSession = vi.hoisted(() => ({ active: true }));

// The real Live TV session service needs a Valkey coordination client. This
// suite controls the resolver state to prove validation and renewal both
// consult Live liveness without refreshing the viewer.
vi.mock('./livetv/livetv-session.service.js', () => ({
    getLiveTvSessionService: () => ({
        // Read-only view used by renewal; the real getPlaybackSession ends sessions.
        peekPlaybackSession: async (sessionId: string) => ({
            sessionId,
            username: derivedUsername(userId),
            state: liveSession.active ? 'active' : 'ended',
        }),
        getPlaybackSession: async (sessionId: string) => ({
            sessionId,
            username: derivedUsername(userId),
            state: liveSession.active ? 'active' : 'ended',
        }),
        refreshPlaybackSession: async () => undefined,
    }),
}));

async function validatePlaybackGrant(...args: Parameters<typeof validateGrant>) {
    const result = await validateGrant(...args);
    return 'reason' in result ? null : result;
}

const userId = toUserId(randomUUID());
const mediaId = randomUUID();
const playbackSessionId = randomUUID();
const context = {
    clientIp: '192.0.2.8',
    route: { mediaId, playbackSessionId, kind: 'video' as const },
};

beforeEach(async () => {
    invalidatePlaybackGrantCache();
    liveSession.active = true;
    const sql = getTestDb();
    await ensureTestUser(sql, userId);
    vi.spyOn(config, 'LIVETV_GROUPS', 'get').mockReturnValue(['grant-live']);
    await sql`UPDATE users SET groups = ARRAY['grant-live']::text[] WHERE id = ${userId}`;
    await insertTestMediaItem(sql, createTestMediaItem({ id: mediaId, media_type: 'movie' }));
    await sql`INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
        VALUES (${playbackSessionId}, ${mediaId}, ${userId}, 'test-grant', '192.0.2.8'::inet, 'direct') ON CONFLICT (id) DO NOTHING`;
});
afterEach(async () => {
    vi.restoreAllMocks();
    const sql = getTestDb();
    await sql`DELETE FROM play_sessions WHERE user_id = ${userId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM media_items WHERE id = ${mediaId}`;
});

describe('restart-orphaned video grants', () => {
    it.each([true, false])(
        'returns a recoverable restart denial (grant active=%s)',
        async (active) => {
            const sql = getTestDb();
            const grant = await mintPlaybackGrant({
                userId,
                mediaId,
                playbackSessionId,
                kind: 'video',
                clientIp: context.clientIp,
            });
            await sql`UPDATE play_sessions SET status = 'CRASHED', stop_reason = 'server_restart',
            stopped_at = NOW() WHERE id = ${playbackSessionId}`;
            if (!active) await revokeGrantsForPlaySession(playbackSessionId, sql, 'reaped');
            invalidatePlaybackGrantCache(grant.id);

            expect(await validateGrant(grant.token, context)).toEqual({
                reason: 'session_restarted',
                grantId: grant.id,
            });
            // Restart recovery is a fresh authenticated start, never grant renewal.
            expect(await renewPlaybackGrant(grant.id, userId, 'v1', grant.token)).toBeNull();
        },
    );

    it.each([
        { status: 'COMPLETED', stopReason: 'switch', grantReason: 'stopped' as const },
        { status: 'KILLED', stopReason: 'admin', grantReason: 'admin_kill' as const },
        { status: 'KILLED', stopReason: 'superseded', grantReason: 'superseded' as const },
        { status: 'CRASHED', stopReason: 'heartbeat_timeout', grantReason: 'reaped' as const },
    ])(
        'keeps $stopReason termination non-recoverable',
        async ({ status, stopReason, grantReason }) => {
            const sql = getTestDb();
            const grant = await mintPlaybackGrant({
                userId,
                mediaId,
                playbackSessionId,
                kind: 'video',
                clientIp: context.clientIp,
            });
            await sql`UPDATE play_sessions SET status = ${status}, stop_reason = ${stopReason},
            stopped_at = NOW() WHERE id = ${playbackSessionId}`;
            await revokeGrantsForPlaySession(playbackSessionId, sql, grantReason);

            expect(await validateGrant(grant.token, context)).toEqual({
                reason: 'session_ended',
                grantId: grant.id,
            });
        },
    );

    it('keeps explicit grant revocation terminal even if its session was restart-orphaned', async () => {
        const sql = getTestDb();
        const grant = await mintPlaybackGrant({
            userId,
            mediaId,
            playbackSessionId,
            kind: 'video',
            clientIp: context.clientIp,
        });
        await revokePlaybackGrant(grant.id, userId);
        await sql`UPDATE play_sessions SET status = 'CRASHED', stop_reason = 'server_restart',
            stopped_at = NOW() WHERE id = ${playbackSessionId}`;

        expect(await validateGrant(grant.token, context)).toEqual({
            reason: 'revoked',
            grantId: grant.id,
        });
    });

    it('makes a reaped restart grant terminal when its owner explicitly revokes it', async () => {
        const sql = getTestDb();
        const grant = await mintPlaybackGrant({
            userId,
            mediaId,
            playbackSessionId,
            kind: 'video',
            clientIp: context.clientIp,
        });
        await sql`UPDATE play_sessions SET status = 'CRASHED', stop_reason = 'server_restart',
            stopped_at = NOW() WHERE id = ${playbackSessionId}`;
        await revokeGrantsForPlaySession(playbackSessionId, sql, 'reaped');
        expect(await validateGrant(grant.token, context)).toEqual({
            reason: 'session_restarted',
            grantId: grant.id,
        });

        expect(await revokePlaybackGrant(grant.id, randomUUID())).toBe(false);
        expect(await validateGrant(grant.token, context)).toEqual({
            reason: 'session_restarted',
            grantId: grant.id,
        });
        expect(await revokePlaybackGrant(grant.id, userId)).toBe(true);
        expect(await validateGrant(grant.token, context)).toEqual({
            reason: 'revoked',
            grantId: grant.id,
        });
        const [persisted] = await sql<{ is_active: boolean; ended_reason: string }[]>`
            SELECT is_active, ended_reason FROM hls_playback_tokens WHERE id = ${grant.id}`;
        expect(persisted).toEqual({ is_active: false, ended_reason: 'client_request' });
    });

    it('preserves disabled-account denial for reaped restart grants', async () => {
        const sql = getTestDb();
        const grant = await mintPlaybackGrant({
            userId,
            mediaId,
            playbackSessionId,
            kind: 'video',
            clientIp: context.clientIp,
        });
        await sql`UPDATE play_sessions SET status = 'CRASHED', stop_reason = 'server_restart',
            stopped_at = NOW() WHERE id = ${playbackSessionId}`;
        await revokeGrantsForPlaySession(playbackSessionId, sql, 'reaped');
        await sql`UPDATE users SET disabled_at = NOW() WHERE id = ${userId}`;

        expect(await validateGrant(grant.token, context)).toEqual({
            reason: 'revoked',
            grantId: grant.id,
        });
    });
});

describe('persisted grant renewal', () => {
    it('keeps the first video secret valid 23 hours after minting with no renewal', async () => {
        const sql = getTestDb();
        const before = Date.now();
        const grant = await mintPlaybackGrant({
            userId,
            mediaId,
            playbackSessionId,
            kind: 'video',
            clientIp: context.clientIp,
        });
        expect(grant.expiresAt.getTime() - before).toBeGreaterThanOrEqual(24 * 3_600_000);
        // Move the persisted lifetime back 23h so PostgreSQL's real clock tests
        // the same boundary as a player opening this first URL tomorrow.
        await sql`UPDATE hls_playback_tokens SET created_at = created_at - interval '23 hours',
            expires_at = expires_at - interval '23 hours' WHERE id = ${grant.id}`;
        expect(await validatePlaybackGrant(grant.token, context)).not.toBeNull();
    });

    it.each([false, true])(
        'keeps a report-less session alive with media fetches (paused=%s)',
        async (paused) => {
            const sql = getTestDb();
            await sql`INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
            VALUES (${playbackSessionId}, ${mediaId}, ${userId}, 'external-player', '192.0.2.8'::inet, 'direct') ON CONFLICT (id) DO NOTHING`;
            const grant = await mintPlaybackGrant({
                userId,
                mediaId,
                playbackSessionId,
                kind: 'video',
                clientIp: context.clientIp,
            });
            for (let i = 0; i < 2; i++) {
                // Past the ordinary 5-minute silence / 30-minute paused deadline.
                await sql`UPDATE play_sessions SET last_heartbeat_at = NOW() - interval '6 minutes',
                last_seen_at = NOW() - interval '6 minutes',
                status = ${paused ? 'PAUSED' : 'ACTIVE'},
                paused_at = ${paused ? new Date(Date.now() - 31 * 60_000) : null}
                WHERE id = ${playbackSessionId}`;
                await sql`UPDATE hls_playback_tokens SET last_used_at = NOW() - interval '6 minutes' WHERE id = ${grant.id}`;
                invalidatePlaybackGrantCache(grant.id);
                expect(await validatePlaybackGrant(grant.token, context)).not.toBeNull();
                const [activity] =
                    await sql`SELECT last_heartbeat_at > NOW() - interval '15 seconds' AS recent FROM play_sessions WHERE id = ${playbackSessionId}`;
                expect(activity.recent).toBe(true);
                expect(await claimStaleSessionsForUser(sql, userId)).toHaveLength(0);
                // The same predicate is negated by compat admission counting.
                await sql`UPDATE play_sessions SET surface = 'jellyfin_compat' WHERE id = ${playbackSessionId}`;
                expect(
                    (await getLiveJellyfinCompatSessions(sql)).some(
                        (row) => row.id === playbackSessionId,
                    ),
                ).toBe(true);
            }
            const [first] =
                await sql`SELECT last_heartbeat_at FROM play_sessions WHERE id = ${playbackSessionId}`;
            await validatePlaybackGrant(grant.token, context);
            const [second] =
                await sql`SELECT last_heartbeat_at FROM play_sessions WHERE id = ${playbackSessionId}`;
            expect(second.last_heartbeat_at).toEqual(first.last_heartbeat_at);
            await sql`UPDATE play_sessions SET last_heartbeat_at = NOW() - interval '6 minutes', last_seen_at = NOW() - interval '6 minutes' WHERE id = ${playbackSessionId}`;
            await sql`UPDATE hls_playback_tokens SET last_used_at = NOW() - interval '6 minutes' WHERE id = ${grant.id}`;
            expect(await claimStaleSessionsForUser(sql, userId)).toHaveLength(1);
            invalidatePlaybackGrantCache(grant.id);
            expect(await validatePlaybackGrant(grant.token, context)).toBeNull();
        },
    );

    it('pins by default, permits cast from another IP, and respects the admin gate', async () => {
        vi.spyOn(config, 'STREAMING_SESSION_ENFORCE_IP', 'get').mockReturnValue(true);
        const policy = vi.spyOn(config, 'STREAM_TOKEN_WILDCARD_IP', 'get').mockReturnValue(true);
        const params = {
            userId,
            mediaId,
            playbackSessionId,
            kind: 'video' as const,
            clientIp: context.clientIp,
        };
        const otherIp = { ...context, clientIp: '192.0.2.99' };
        const pinned = await mintPlaybackGrant(params);
        expect(await validatePlaybackGrant(pinned.token, otherIp)).toBeNull();
        const cast = await mintPlaybackGrant({ ...params, castTarget: true });
        expect(cast.clientIp).toBe('*');
        expect(await validatePlaybackGrant(cast.token, otherIp)).not.toBeNull();
        expect(
            await validatePlaybackGrant(cast.token, {
                ...otherIp,
                route: { ...context.route, playbackSessionId: randomUUID() },
            }),
        ).toBeNull();
        policy.mockReturnValue(false);
        const denied = await mintPlaybackGrant({ ...params, castTarget: true });
        expect(denied.clientIp).toBe(context.clientIp);
        expect(await validatePlaybackGrant(denied.token, otherIp)).toBeNull();
    });

    it('preserves the same secret across repeated renewals and revokes it', async () => {
        const first = await mintPlaybackGrant({
            userId,
            mediaId,
            playbackSessionId,
            kind: 'video',
            clientIp: context.clientIp,
        });
        expect(await renewPlaybackGrant(first.id, randomUUID(), 'v1', first.token)).toBeNull();
        const second = await renewPlaybackGrant(first.id, userId, 'v1', first.token);
        const third = await renewPlaybackGrant(first.id, userId, 'v1', first.token);
        expect(second?.id).toBe(first.id);
        expect(third?.id).toBe(first.id);
        expect(second?.token).toBe(first.token);
        expect(third?.token).toBe(first.token);
        expect(await validatePlaybackGrant(first.token, context)).not.toBeNull();
        expect(await revokePlaybackGrant(first.id, userId)).toBe(true);
        expect(await validatePlaybackGrant(first.token, context)).toBeNull();
    });

    it.each(['video', 'music', 'audiobook', 'live'] as const)(
        'requires an existing playable session for bound %s grants, leaving live to its resolver',
        async (kind) => {
            const missingSession = randomUUID();
            const grant = await mintPlaybackGrant({
                userId,
                mediaId,
                playbackSessionId: missingSession,
                kind,
                clientIp: '*',
            });
            const route = { mediaId, playbackSessionId: missingSession, kind };
            const valid = await validatePlaybackGrant(grant.token, { ...context, route });
            const metadata = await getPlaybackGrant(grant.id, userId);
            const renewed = await renewPlaybackGrant(grant.id, userId, 'v1', grant.token);
            if (kind === 'live') {
                expect(valid).not.toBeNull();
                expect(metadata).not.toBeNull();
                expect(renewed).not.toBeNull();
            } else {
                expect(valid).toBeNull();
                expect(metadata).toBeNull();
                expect(renewed).toBeNull();
            }
        },
    );

    it('extends only the selected grant and enforces the absolute lifetime', async () => {
        const sql = getTestDb();
        const params = {
            userId,
            mediaId,
            playbackSessionId,
            kind: 'video' as const,
            clientIp: context.clientIp,
        };
        const first = await mintPlaybackGrant(params);
        const other = await mintPlaybackGrant(params);
        await sql`UPDATE hls_playback_tokens SET created_at = NOW() - interval '6 days 23 hours',
            expires_at = NOW() + interval '10 minutes' WHERE id = ${first.id}`;
        const current = await renewPlaybackGrant(first.id, userId, 'v1', first.token);
        expect(current?.token).toBe(first.token);
        const [persisted] =
            await sql`SELECT expires_at <= created_at + interval '7 days' AS capped FROM hls_playback_tokens WHERE id = ${first.id}`;
        expect(persisted.capped).toBe(true);
        expect((await getPlaybackGrant(other.id, userId))?.expiresAt).toEqual(other.expiresAt);
        expect(await validatePlaybackGrant(current!.token, context)).not.toBeNull();
    });

    it('refuses validation and renewal after a terminal session even if cleanup has not run', async () => {
        const sql = getTestDb();
        await sql`
            INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
            VALUES (${playbackSessionId}, ${mediaId}, ${userId}, 'test-grant', '192.0.2.8'::inet, 'direct') ON CONFLICT (id) DO NOTHING
        `;
        const grant = await mintPlaybackGrant({
            userId,
            mediaId,
            playbackSessionId,
            kind: 'video',
            clientIp: '*',
        });
        expect(await validatePlaybackGrant(grant.token, context)).not.toBeNull();
        await sql`UPDATE play_sessions SET status = 'COMPLETED' WHERE id = ${playbackSessionId}`;
        invalidatePlaybackGrantCache(grant.id);
        expect(await validatePlaybackGrant(grant.token, context)).toBeNull();
        expect(await renewPlaybackGrant(grant.id, userId, 'v1', grant.token)).toBeNull();
        expect(await getPlaybackGrant(grant.id, userId)).toBeNull();
    });

    it('owner cancellation revokes a warmed delivery grant without inventing progress', async () => {
        const sql = getTestDb();
        await sql`UPDATE play_sessions SET position_ms = 1234, last_event_seq = 7 WHERE id = ${playbackSessionId}`;
        const grant = await mintPlaybackGrant({
            userId,
            mediaId,
            playbackSessionId,
            kind: 'video',
            clientIp: context.clientIp,
        });
        expect(await validatePlaybackGrant(grant.token, context)).not.toBeNull();
        const [before] =
            await sql`SELECT position_ms, last_event_seq FROM play_sessions WHERE id = ${playbackSessionId}`;
        const response = await cancellationDef.handlers.DELETE!(
            {
                locals: {
                    user: { userId, username: derivedUsername(userId) },
                    principal: {
                        kind: 'session',
                        userId,
                        username: derivedUsername(userId),
                        isAdmin: false,
                        scopes: ['media:write'],
                    },
                },
                params: { id: playbackSessionId },
            } as never,
            { surface: 'v1', input: { params: { id: playbackSessionId } } } as never,
        );
        expect(response.status).toBe(204);
        const [after] =
            await sql`SELECT position_ms, last_event_seq FROM play_sessions WHERE id = ${playbackSessionId}`;
        expect(after).toEqual(before);
        expect(await validatePlaybackGrant(grant.token, context)).toBeNull();
        expect(await renewPlaybackGrant(grant.id, userId, 'v1', grant.token)).toBeNull();
        const [{ n }] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM watch_history WHERE source_play_session_id = ${playbackSessionId}`;
        expect(n).toBe(0);
    });

    it('revokes precisely the playback-session binding', async () => {
        const first = await mintPlaybackGrant({
            userId,
            mediaId,
            playbackSessionId,
            kind: 'video',
            clientIp: '*',
        });
        const otherSession = randomUUID();
        await getTestDb()`INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
            VALUES (${otherSession}, ${mediaId}, ${userId}, 'other', '192.0.2.8'::inet, 'direct')`;

        const other = await mintPlaybackGrant({
            userId,
            mediaId,
            playbackSessionId: otherSession,
            kind: 'video',
            clientIp: '*',
        });
        expect(await revokeGrantsForPlaySession(playbackSessionId)).toBe(1);
        expect(await validatePlaybackGrant(first.token, context)).toBeNull();
        expect(
            await validatePlaybackGrant(other.token, {
                ...context,
                route: { ...context.route, playbackSessionId: otherSession },
            }),
        ).not.toBeNull();
    });
});

describe('grant failure reasons', () => {
    it.each(['stopped', 'reaped', 'superseded', 'admin_kill'] as const)(
        'reports session_ended with the grant id when its session ends as %s',
        async (reason) => {
            const sql = getTestDb();
            const grant = await mintPlaybackGrant({
                userId,
                mediaId,
                playbackSessionId,
                kind: 'video',
                clientIp: context.clientIp,
            });
            expect(await validatePlaybackGrant(grant.token, context)).not.toBeNull();
            await revokeGrantsForPlaySession(playbackSessionId, sql, reason);
            const [persisted] = await sql<{ ended_reason: string }[]>`
                SELECT ended_reason FROM hls_playback_tokens WHERE id = ${grant.id}
            `;
            expect(persisted.ended_reason).toBe(reason);
            expect(await validateGrant(grant.token, context)).toEqual({
                reason: 'session_ended',
                grantId: grant.id,
            });
        },
    );

    it('reports revoked, not session_ended, after the client revokes the grant', async () => {
        const grant = await mintPlaybackGrant({
            userId,
            mediaId,
            playbackSessionId,
            kind: 'video',
            clientIp: context.clientIp,
        });
        expect(await validatePlaybackGrant(grant.token, context)).not.toBeNull();
        expect(await revokePlaybackGrant(grant.id, userId)).toBe(true);
        expect(await validateGrant(grant.token, context)).toEqual({
            reason: 'revoked',
            grantId: grant.id,
        });
    });

    it('reports expired for a grant the sweeper closed as expired', async () => {
        const sql = getTestDb();
        const grant = await mintPlaybackGrant({
            userId,
            mediaId,
            playbackSessionId,
            kind: 'video',
            clientIp: context.clientIp,
        });
        expect(await validatePlaybackGrant(grant.token, context)).not.toBeNull();
        await sql`UPDATE hls_playback_tokens SET is_active = false, ended_reason = 'expired'
            WHERE id = ${grant.id}`;
        invalidatePlaybackGrantCache(grant.id);
        expect(await validateGrant(grant.token, context)).toEqual({
            reason: 'expired',
            grantId: grant.id,
        });
    });
});

it('does not extend a persisted grant after its Live session ends', async () => {
    const grant = await mintPlaybackGrant({
        userId,
        mediaId,
        playbackSessionId,
        kind: 'live',
        clientIp: context.clientIp,
    });
    expect(await renewPlaybackGrant(grant.id, userId, 'v1', grant.token)).not.toBeNull();
    liveSession.active = false;
    const sql = getTestDb();
    const [before] = await sql`SELECT expires_at FROM hls_playback_tokens WHERE id = ${grant.id}`;
    expect(await renewPlaybackGrant(grant.id, userId, 'v1', grant.token)).toBeNull();
    const [after] = await sql`SELECT expires_at FROM hls_playback_tokens WHERE id = ${grant.id}`;
    expect(after.expires_at).toEqual(before.expires_at);
});

describe('preview grant liveness against real grant SQL', () => {
    it('validates and renews a fresh preview, then rejects it immediately after teardown', async () => {
        const previewId = `preview-${randomUUID()}`;
        const preview: PreviewSession = {
            playSessionId: previewId,
            itemId: mediaId,
            userId,
            transcodeMode: 'direct',
            startPositionSeconds: 0,
            isPreview: true,
            createdAt: new Date(),
            lastHeartbeatAt: new Date(),
        };
        await addPreviewSession(preview);
        try {
            const grant = await mintPlaybackGrant({
                userId,
                mediaId,
                playbackSessionId: previewId,
                kind: 'preview',
                clientIp: context.clientIp,
            });
            const previewContext = {
                ...context,
                route: { ...context.route, playbackSessionId: previewId, previewDelivery: true },
            };
            expect(await validateGrant(grant.token, previewContext)).toMatchObject({
                id: grant.id,
            });
            expect(await getPlaybackGrant(grant.id, userId)).toMatchObject({ id: grant.id });
            expect(await renewPlaybackGrant(grant.id, userId, 'v1', grant.token)).toMatchObject({
                token: grant.token,
            });
            // Leave the DB grant active: liveness must come from the preview store,
            // including when the positive grant cache has already been warmed.
            await cleanupPreviewSession(previewId, preview, userId);
            expect(await validateGrant(grant.token, previewContext)).toEqual({
                reason: 'session_ended',
                grantId: grant.id,
            });
            expect(await getPlaybackGrant(grant.id, userId)).toBeNull();
            expect(await renewPlaybackGrant(grant.id, userId, 'v1', grant.token)).toBeNull();
        } finally {
            await cleanupPreviewSession(previewId, preview, userId);
        }
    });

    it.each(['heartbeat', 'absolute', 'owner', 'media'] as const)(
        'rejects a preview with stale or mismatched %s state before cleanup',
        async (state) => {
            const previewId = `preview-${randomUUID()}`;
            const preview: PreviewSession = {
                playSessionId: previewId,
                itemId: state === 'media' ? randomUUID() : mediaId,
                userId: state === 'owner' ? toUserId(randomUUID()) : userId,
                transcodeMode: 'direct',
                startPositionSeconds: 0,
                isPreview: true,
                createdAt: new Date(Date.now() - (state === 'absolute' ? 301_000 : 0)),
                lastHeartbeatAt: new Date(Date.now() - (state === 'heartbeat' ? 31_000 : 0)),
            };
            await addPreviewSession(preview);
            try {
                const grant = await mintPlaybackGrant({
                    userId,
                    mediaId,
                    playbackSessionId: previewId,
                    kind: 'preview',
                    clientIp: context.clientIp,
                });
                expect(
                    await validateGrant(grant.token, {
                        ...context,
                        route: {
                            ...context.route,
                            playbackSessionId: previewId,
                            previewDelivery: true,
                        },
                    }),
                ).toEqual({ reason: 'session_ended', grantId: grant.id });
                expect(await getPlaybackGrant(grant.id, userId)).toBeNull();
                expect(await renewPlaybackGrant(grant.id, userId, 'v1', grant.token)).toBeNull();
            } finally {
                await cleanupPreviewSession(previewId, preview, preview.userId);
            }
        },
    );
});

describe('persisted preview delivery scope', () => {
    it.each(['/api', '/api/v1'])(
        'limits the issued preview URL on %s to its HLS and lifecycle',
        async (prefix) => {
            const previewId = `preview-${randomUUID()}`;
            const preview: PreviewSession = {
                playSessionId: previewId,
                itemId: mediaId,
                userId,
                transcodeMode: 'direct',
                startPositionSeconds: 0,
                isPreview: true,
                createdAt: new Date(),
                lastHeartbeatAt: new Date(),
            };
            await addPreviewSession(preview);
            try {
                // Exercise the real production preview mint, not a manually chosen grant kind.
                const href = await buildPreviewStreamHref(
                    { userId, authMethod: 'bearer', clientIp: context.clientIp },
                    mediaId,
                    previewId,
                    randomUUID(),
                );
                const issued = new URL(href, 'https://test');
                const token = issued.searchParams.get('grant')!;
                const [stored] =
                    await getTestDb()`SELECT id, grant_kind FROM hls_playback_tokens WHERE play_session_id = ${previewId}`;
                expect(stored.grant_kind).toBe('preview');
                const classify = (path: string, session = previewId) =>
                    resolvePlaybackGrantRoute(
                        new URL(`https://test${prefix}${path}?PlaySessionId=${session}`),
                    );
                for (const resource of [
                    'master.m3u8',
                    'index.m3u8',
                    'init_0.mp4',
                    'segment_00000.ts',
                    'stream_0/segment_00000.m4s',
                ]) {
                    const route = await classify(`/playback/${mediaId}/hls/${resource}`);
                    expect(route).not.toBeNull();
                    expect(
                        await validateGrant(token, { clientIp: context.clientIp, route: route! }),
                    ).toHaveProperty('id', stored.id);
                }
                for (const suffix of ['', '/keepalive']) {
                    const route = await classify(`/playback/previews/${previewId}${suffix}`);
                    expect(route).not.toBeNull();
                    expect(
                        await validateGrant(token, { clientIp: context.clientIp, route: route! }),
                    ).toHaveProperty('id', stored.id);
                }
                // Positive cache is warm: every request must still recheck route scope.
                for (const path of [
                    `/playback/${mediaId}/file`,
                    `/playback/${mediaId}/stream`,
                    `/Videos/${mediaId}/stream`,
                    `/playback/subtitles/${mediaId}/0`,
                    `/playback/${mediaId}/trickplay/320/0.jpg`,
                    `/playback/${mediaId}/hls/trickplay.m3u8`,
                    `/playback/${mediaId}/hls/subs_0/index.m3u8`,
                    `/playback/${mediaId}/avp/nonce/hls`,
                ]) {
                    const route = await classify(path);
                    expect(route).not.toBeNull();
                    expect(
                        await validateGrant(token, { clientIp: context.clientIp, route: route! }),
                    ).toEqual({ reason: 'wrong_scope', grantId: stored.id });
                }
                // Downloads never accept any playback grant, even with a matching binding.
                expect(await classify(`/media/${mediaId}/download`)).toBeNull();
                const foreign = await classify(
                    `/playback/${mediaId}/hls/master.m3u8`,
                    `preview-${randomUUID()}`,
                );
                expect(
                    await validateGrant(token, { clientIp: context.clientIp, route: foreign! }),
                ).toEqual({ reason: 'wrong_scope', grantId: stored.id });

                const normal = await mintPlaybackGrant({
                    userId,
                    mediaId,
                    playbackSessionId,
                    kind: 'video',
                    clientIp: context.clientIp,
                });
                for (const path of [
                    `/playback/${mediaId}/file`,
                    `/playback/${mediaId}/stream`,
                    `/Videos/${mediaId}/stream`,
                ]) {
                    const route = await classify(path, playbackSessionId);
                    expect(
                        await validateGrant(normal.token, {
                            clientIp: context.clientIp,
                            route: route!,
                        }),
                    ).toHaveProperty('id', normal.id);
                }
            } finally {
                await cleanupPreviewSession(previewId, preview, userId);
            }
        },
    );
});

it('revoking Live TV removes only this user live grants and preserves other media', async () => {
    const sql = getTestDb();
    const username = derivedUsername(userId);
    const otherId = toUserId(randomUUID());
    await ensureTestUser(sql, otherId);
    try {
        for (const [owner, kind] of [
            [userId, 'live'],
            [userId, 'video'],
            [otherId, 'live'],
        ] as const) {
            await sql`INSERT INTO hls_playback_tokens (token_hash, username, user_id, client_ip, expires_at, grant_kind)
                VALUES (${randomUUID()}, ${derivedUsername(owner)}, ${owner}, '192.0.2.8', now() + interval '1 hour', ${kind})`;
        }
        await revokeLiveGrantsForUser(sql, username);
        await revokeLiveGrantsForUser(sql, username);
        const rows = await sql<
            { user_id: string; grant_kind: string; is_active: boolean }[]
        >`SELECT user_id, grant_kind, is_active FROM hls_playback_tokens WHERE user_id IN (${userId}, ${otherId})`;
        expect(rows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ user_id: userId, grant_kind: 'live', is_active: false }),
                expect.objectContaining({ user_id: userId, grant_kind: 'video', is_active: true }),
                expect.objectContaining({ user_id: otherId, grant_kind: 'live', is_active: true }),
            ]),
        );
    } finally {
        await sql`DELETE FROM users WHERE id = ${otherId}`;
    }
});

it('C-1: persisted group removal revokes a warm live grant, its renewal and owner context', async () => {
    const { playbackGrantUserContext } = await import('./playback-grant');
    const grant = await mintPlaybackGrant({
        userId,
        mediaId,
        playbackSessionId,
        kind: 'live',
        clientIp: context.clientIp,
    });
    const liveContext = { ...context, route: { ...context.route, kind: 'live' as const } };
    expect(await validatePlaybackGrant(grant.token, liveContext)).not.toBeNull();
    const sql = getTestDb();
    await sql`UPDATE users SET groups = ARRAY[]::text[] WHERE id = ${userId}`;
    expect(await validateGrant(grant.token, liveContext)).toMatchObject({ reason: 'revoked' });
    expect(await renewPlaybackGrant(grant.id, userId, 'v1', grant.token)).toBeNull();
    expect(
        (
            await playbackGrantUserContext({
                grant_kind: 'live',
                username: derivedUsername(userId),
                user_id: userId,
                minted_by_admin: false,
            })
        )?.hasLiveTvPermission,
    ).toBe(false);
});
