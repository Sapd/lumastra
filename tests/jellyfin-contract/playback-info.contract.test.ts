// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
/**
 * /j PlaybackInfo against the jellyfin-sdk-kotlin contract, through the real route
 * handler (withJellyfinAuth included) over real PG + Valkey. Includes leon's shape
 * (episode with only a sidecar .srt) and the free-tier stream-limit clip / refusal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { toUserId } from '$lib/shared/user-id.js';
import { isPolicyError } from '$lib/server/services/play-sessions.service.js';
import { findOrCreateJellyfinSession } from '$lib/server/proprietary/jellyfin-compat/playback-utils.js';
import { callAndCheck, jfEvent, mintJfSession } from './harness';
import webDeviceProfile from '../../src/routes/(proprietary)/j/Items/[itemId]/PlaybackInfo/jellyfin-web-device-profile.fixture.json';
import type { JellyfinPlaybackInfoResponse } from '$lib/server/proprietary/jellyfin-compat/types';
import { seedEpisodeExternalSrt, seedMovieEmbeddedSubs, seedMusicTrack } from './seed';
import {
    POST as playbackInfoPost,
    GET as playbackInfoGet,
} from '../../src/routes/(proprietary)/j/Items/[itemId]/PlaybackInfo/+server';

// The free-tier /j stream cap. null (no cap) except in the stream-limit cases; the
// rest of the entitlement object stays real.
const h = vi.hoisted(() => ({ cap: null as number | null }));
vi.mock('$lib/server/licensing/entitlements', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/licensing/entitlements')>();
    return {
        ...actual,
        getEffectiveEntitlements: async (
            ...args: Parameters<typeof actual.getEffectiveEntitlements>
        ) => {
            const real = await actual.getEffectiveEntitlements(...args);
            return h.cap === null ? real : { ...real, jellyfinMaxConcurrentStreams: h.cap };
        },
    };
});

const USER_ID = '00000000-0000-4000-8000-00000000c0de';
const OTHER_USER_ID = '00000000-0000-4000-8000-00000000c0df';
let sql: postgres.Sql;
let token: string;
let username: string;

const DEVICE_PROFILE = {
    MaxStreamingBitrate: 120000000,
    DirectPlayProfiles: [
        {
            Container: 'mkv,mp4',
            Type: 'Video',
            VideoCodec: 'h264,hevc',
            AudioCodec: 'aac,ac3,eac3',
        },
    ],
    TranscodingProfiles: [
        {
            Container: 'ts',
            Type: 'Video',
            VideoCodec: 'h264',
            AudioCodec: 'aac',
            Protocol: 'hls',
            Context: 'Streaming',
        },
    ],
    SubtitleProfiles: [
        { Format: 'srt', Method: 'External' },
        { Format: 'pgssub', Method: 'Embed' },
    ],
};

/** Another user's live /j stream, filling a cap of 1. */
async function occupyStreamCap(): Promise<void> {
    await ensureTestUser(sql, OTHER_USER_ID);
    const [{ username: other }] = await sql<{ username: string }[]>`
        SELECT username FROM users WHERE id = ${OTHER_USER_ID}`;
    const { itemId } = await seedMovieEmbeddedSubs(sql);
    const result = await findOrCreateJellyfinSession(sql, {
        userId: toUserId(OTHER_USER_ID),
        username: other,
        itemId,
        positionMs: 0,
        ipAddress: '127.0.0.2',
        device: {
            deviceId: 'other-device',
            deviceName: 'Other TV',
            clientName: 'Jellyfin Android TV',
        },
    });
    if (isPolicyError(result)) throw new Error(`policy blocked: ${result.kind}`);
}

beforeAll(async () => {
    sql = getTestDb();
    // /j sessions live in Valkey; the client connects only on demand.
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
});
afterAll(async () => {
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    h.cap = null;
    await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    await sql`
        UPDATE play_sessions SET status = 'COMPLETED', stopped_at = now()
        WHERE status IN ('ACTIVE', 'PAUSED')`;
    await ensureTestUser(sql, USER_ID);
    [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });
});

describe('/j PlaybackInfo contract', () => {
    it('movie with two audio tracks and embedded text + PGS subs (POST + DeviceProfile)', async () => {
        const { itemId } = await seedMovieEmbeddedSubs(sql);
        const path = `/j/Items/${itemId}/PlaybackInfo`;
        await callAndCheck(
            'playbackinfo-movie-embedded',
            'PlaybackInfoResponse',
            playbackInfoPost,
            jfEvent({
                method: 'POST',
                path,
                token,
                params: { itemId },
                body: { DeviceProfile: DEVICE_PROFILE, UserId: USER_ID },
            }),
        );
    });

    for (const client of ['Jellyfin Web', 'Infuse', 'Swiftfin']) {
        it(`${client}: negotiated transport keeps the Kotlin DTO contract`, async () => {
            const { itemId, fileId } = await seedMovieEmbeddedSubs(sql);
            // Match the captured H.264/AAC source, including its container.
            await sql`UPDATE media_streams SET codec = 'h264', profile = 'High', level = 30,
                bit_depth = 8, video_range_type = 'SDR', pixel_format = 'yuv420p'
                WHERE file_id = ${fileId} AND stream_type = 'video'`;
            await sql`UPDATE media_streams SET codec = 'aac', channels = 2
                WHERE file_id = ${fileId} AND stream_type = 'audio'`;
            const body = (await callAndCheck(
                `playbackinfo-transport-${client.replaceAll(' ', '-').toLowerCase()}`,
                'PlaybackInfoResponse',
                playbackInfoPost,
                jfEvent({
                    method: 'POST',
                    path: `/j/Items/${itemId}/PlaybackInfo`,
                    token,
                    client,
                    params: { itemId },
                    body: { DeviceProfile: webDeviceProfile },
                }),
            )) as JellyfinPlaybackInfoResponse;
            const source = body.MediaSources[0];
            expect(source.SupportsDirectPlay).toBe(client !== 'Jellyfin Web');
            if (client === 'Jellyfin Web') {
                expect(source.TranscodingUrl).toContain('/master.m3u8?');
                expect(source.TranscodingSubProtocol).toBe('hls');
            } else {
                expect(source.TranscodingUrl).toBeUndefined();
                expect(source.TranscodingSubProtocol).toBe('http');
            }
        });
    }

    it('episode with a sidecar .srt (leon) — GET and POST', async () => {
        const { itemId } = await seedEpisodeExternalSrt(sql);
        const path = `/j/Items/${itemId}/PlaybackInfo`;
        await callAndCheck(
            'playbackinfo-episode-external-srt-get',
            'PlaybackInfoResponse',
            playbackInfoGet,
            jfEvent({ method: 'GET', path, token, params: { itemId } }),
        );
        await callAndCheck(
            'playbackinfo-episode-external-srt-post',
            'PlaybackInfoResponse',
            playbackInfoPost,
            jfEvent({
                method: 'POST',
                path,
                token,
                params: { itemId },
                body: { DeviceProfile: DEVICE_PROFILE },
            }),
        );
    });

    it('free-tier stream cap reached by another user: the limit clip (video)', async () => {
        h.cap = 1;
        await occupyStreamCap();
        const { itemId } = await seedEpisodeExternalSrt(sql);
        const body = (await callAndCheck(
            'playbackinfo-stream-limit-clip',
            'PlaybackInfoResponse',
            playbackInfoPost,
            jfEvent({
                method: 'POST',
                path: `/j/Items/${itemId}/PlaybackInfo`,
                token,
                params: { itemId },
                body: { DeviceProfile: DEVICE_PROFILE, PlaySessionId: randomUUID() },
            }),
        )) as { PlaySessionId: string; MediaSources: { Id: string }[] };
        // The clip, not the real media: its source id doubles as the PlaySessionId.
        expect(body.MediaSources).toHaveLength(1);
        expect(body.MediaSources[0].Id).toBe(body.PlaySessionId);
    });

    it('free-tier stream cap reached by another user: RateLimitExceeded refusal (audio)', async () => {
        h.cap = 1;
        await occupyStreamCap();
        const { itemId } = await seedMusicTrack(sql);
        const body = (await callAndCheck(
            'playbackinfo-stream-limit-refusal',
            'PlaybackInfoResponse',
            playbackInfoPost,
            jfEvent({
                method: 'POST',
                path: `/j/Items/${itemId}/PlaybackInfo`,
                token,
                params: { itemId },
                body: { DeviceProfile: DEVICE_PROFILE },
            }),
        )) as { ErrorCode?: string; MediaSources: unknown[] };
        expect(body.ErrorCode).toBe('RateLimitExceeded');
        expect(body.MediaSources).toEqual([]);
    });
});
