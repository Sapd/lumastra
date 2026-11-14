// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /j PlaybackInfo against the jellyfin-sdk-kotlin contract, through the real route
 * handler (withJellyfinAuth included) over real PG + Valkey. Includes leon's shape
 * (episode with only a sidecar .srt).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { callAndCheck, jfEvent, mintJfSession } from './harness';
import webDeviceProfile from '../../src/routes/(modules)/j/Items/[itemId]/PlaybackInfo/jellyfin-web-device-profile.fixture.json';
import type { JellyfinPlaybackInfoResponse } from '$lib/server/jellyfin-compat/types';
import { seedEpisodeExternalSrt, seedMovieEmbeddedSubs } from './seed';
import {
    POST as playbackInfoPost,
    GET as playbackInfoGet,
} from '../../src/routes/(modules)/j/Items/[itemId]/PlaybackInfo/+server';

const USER_ID = '00000000-0000-4000-8000-00000000c0de';
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
});
