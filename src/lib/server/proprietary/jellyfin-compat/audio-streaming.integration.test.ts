// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// /j audio delivery against a real file and real ffmpeg:
//   /Audio/{id}/stream.{container}  — direct (incl. a byte range), static, transcode
//   /Audio/{id}/master.m3u8 → main.m3u8 → hls1/main/{segment}
//
// withJellyfinAuth is stubbed so the test picks its caller; access denial is
// an age-restricted caller on an 18-rated track. Skips without ffmpeg or a DB.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { haveFfmpeg } from '../../../../../tests/helpers/have-ffmpeg';

const dirs = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir: td } = require('node:os') as typeof import('node:os');
    return {
        cache: mk(`${td()}/jf-music-cache-`),
        transcode: mk(`${td()}/jf-hls-`),
    };
});

vi.mock('$lib/server/config', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/config')>();
    const overrides: Record<string, unknown> = {
        FFMPEG_PATH: 'ffmpeg',
        FFMPEG_TRANSCODE_DIR: dirs.transcode,
        MUSIC_TRANSCODE_CACHE_DIR: dirs.cache,
    };
    const config = new Proxy(mod.config, {
        get: (target, key, receiver) =>
            typeof key === 'string' && key in overrides
                ? overrides[key]
                : Reflect.get(target, key, receiver),
    });
    const features = new Proxy(mod.features, {
        get: (target, key, receiver) =>
            key === 'ffmpegAvailable' ? true : Reflect.get(target, key, receiver),
    });
    return { ...mod, config, features };
});

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('./middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database')>();
    const { getTestDb: getSql } =
        await import('../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

import { GET as streamByContainer } from '../../../../routes/(proprietary)/j/Audio/[itemId]/stream.[container]/+server';
import { GET as masterPlaylist } from '../../../../routes/(proprietary)/j/Audio/[itemId]/master.m3u8/+server';
import { GET as mainPlaylist } from '../../../../routes/(proprietary)/j/Audio/[itemId]/main.m3u8/+server';
import { GET as hlsSegment } from '../../../../routes/(proprietary)/j/Audio/[itemId]/hls1/[playlistId]/[...segment]/+server';

vi.setConfig({ testTimeout: 60_000 });

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) && haveFfmpeg();

const USER_ID = '00000000-0000-4000-8000-0000000b0001';
const KID_ID = '00000000-0000-4000-8000-0000000b0002';

function event(
    path: string,
    params: Record<string, string>,
    opts: { kid?: boolean; headers?: Record<string, string> } = {},
): RequestEvent {
    const url = new URL(`http://localhost${path}`);
    return {
        url,
        request: new Request(url, { headers: opts.headers }),
        locals: {
            user: {
                username: opts.kid ? 'kid' : 'listener',
                userId: toUserId(opts.kid ? KID_ID : USER_ID),
                groups: '',
                userGroups: [],
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                ownerIsAdmin: false,
                maxAgeRating: opts.kid ? 12 : null,
                isAgeRestricted: !!opts.kid,
                isModerator: false,
                liveTvPriority: 'normal',
            },
            jfToken: 'session-token',
            jfDevice: {
                deviceId: 'audio-test-device',
                deviceName: 'Test',
                clientName: 'Finamp',
                clientVersion: '1.0',
            },
        },
        params,
        route: { id: null },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    } as unknown as RequestEvent;
}

type Handler = (e: RequestEvent) => Promise<Response>;
const run = (h: unknown, e: RequestEvent): Promise<Response> => (h as Handler)(e);

async function seedTrack(sql: postgres.Sql, filePath: string, ageRating: number): Promise<string> {
    const [artist] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, has_files, age_rating)
        VALUES (${`Stream Artist ${ageRating}`}, 'artist', 'active', true, ${ageRating}) RETURNING id`;
    const [album] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, parent_id, status, has_files, age_rating)
        VALUES ('Stream Album', 'album', ${artist.id}, 'active', true, ${ageRating}) RETURNING id`;
    const [track] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, parent_id, status, has_files, age_rating, runtime_seconds)
        VALUES ('Stream Song', 'track', ${album.id}, 'active', true, ${ageRating}, 10) RETURNING id`;
    const [file] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path, file_size_bytes, container_format, duration_seconds, total_bitrate)
        VALUES (${filePath}, 160000, 'mp3', 10, 128000) RETURNING id`;
    await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file.id}, ${track.id}, true)`;
    await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec, channels, channel_layout, sample_rate, bitrate)
              VALUES (${file.id}, 'audio', 0, 'mp3', 2, 'stereo', 44100, 128000)`;
    return track.id;
}

describe.skipIf(!RUN)('/j audio streaming (integration, real ffmpeg)', () => {
    let sql: postgres.Sql;
    let mediaDir: string;
    let trackId: string;
    let ratedId: string;

    beforeAll(async () => {
        sql = getTestDb();
        mediaDir = mkdtempSync(join(tmpdir(), 'jf-audio-'));
        const mp3 = join(mediaDir, 'song.mp3');
        execFileSync('ffmpeg', [
            ...['-hide_banner', '-loglevel', 'error', '-y'],
            ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=10'],
            ...['-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', mp3],
        ]);
        await truncateTables(sql, [...TEST_TABLES.media, 'media_streams']);
        await ensureTestUser(sql, USER_ID);
        await ensureTestUser(sql, KID_ID);
        trackId = await seedTrack(sql, mp3, 6);
        const ratedMp3 = join(mediaDir, 'rated.mp3');
        copyFileSync(mp3, ratedMp3);
        ratedId = await seedTrack(sql, ratedMp3, 18);
    });

    afterAll(async () => {
        rmSync(mediaDir, { recursive: true, force: true });
        rmSync(dirs.cache, { recursive: true, force: true });
        rmSync(dirs.transcode, { recursive: true, force: true });
        await closeTestDb();
    });

    describe('stream.{container}', () => {
        it('serves the file itself for its own container, with byte ranges', async () => {
            const full = await run(
                streamByContainer,
                event(`/j/Audio/${trackId}/stream.mp3`, { itemId: trackId, container: 'mp3' }),
            );
            expect(full.status).toBe(200);
            expect(full.headers.get('content-type')).toMatch(/^audio\/mpeg/);
            const bytes = new Uint8Array(await full.arrayBuffer());
            expect(bytes.length).toBeGreaterThan(10_000);

            const ranged = await run(
                streamByContainer,
                event(
                    `/j/Audio/${trackId}/stream.mp3`,
                    { itemId: trackId, container: 'mp3' },
                    { headers: { range: 'bytes=100-1099' } },
                ),
            );
            expect(ranged.status).toBe(206);
            expect(ranged.headers.get('content-range')).toBe(`bytes 100-1099/${bytes.length}`);
            expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(100, 1100));
        });

        it('static=true serves the original bytes whatever the extension', async () => {
            const res = await run(
                streamByContainer,
                event(`/j/Audio/${trackId}/stream.flac?static=true`, {
                    itemId: trackId,
                    container: 'flac',
                }),
            );
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toMatch(/^audio\/mpeg/);
        });

        it('transcodes to another lossy container', async () => {
            const res = await run(
                streamByContainer,
                event(`/j/Audio/${trackId}/stream.aac?audioBitRate=96000`, {
                    itemId: trackId,
                    container: 'aac',
                }),
            );
            expect(res.status, await res.clone().text()).toBe(200);
            expect(res.headers.get('content-type')).toMatch(/^audio\/(aac|x-aac)/);
            expect(res.headers.get('x-audio-bitrate-kbps')).toBe('96');
            const bytes = new Uint8Array(await res.arrayBuffer());
            expect(bytes.length).toBeGreaterThan(1_000);
            // ADTS frame sync: 0xFFF.
            expect(bytes[0]).toBe(0xff);
            expect(bytes[1] & 0xf0).toBe(0xf0);
        });

        it('refuses lossless targets it would have to encode, and hidden tracks', async () => {
            const flac = await run(
                streamByContainer,
                event(`/j/Audio/${trackId}/stream.flac`, { itemId: trackId, container: 'flac' }),
            );
            // A container the transcoder cannot produce (e1f11aa4bd: 415, not 422).
            expect(flac.status).toBe(415);
            const hidden = await run(
                streamByContainer,
                event(
                    `/j/Audio/${ratedId}/stream.aac`,
                    { itemId: ratedId, container: 'aac' },
                    { kid: true },
                ),
            );
            expect(hidden.status).toBe(404);
            const junk = await run(
                streamByContainer,
                event(`/j/Audio/${trackId}/stream.m%2F`, { itemId: trackId, container: 'm/' }),
            );
            expect(junk.status).toBe(422);
        });
    });

    describe('HLS', () => {
        it('master → main → a playable MPEG-TS segment', async () => {
            const master = await run(
                masterPlaylist,
                event(`/j/Audio/${trackId}/master.m3u8?PlaySessionId=audiohls1`, {
                    itemId: trackId,
                }),
            );
            expect(master.status, await master.clone().text()).toBe(200);
            expect(master.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
            const masterBody = await master.text();
            expect(masterBody).toContain('CODECS="mp4a.40.2"');
            expect(masterBody).toContain('main.m3u8?PlaySessionId=audiohls1&api_key=session-token');

            const main = await run(
                mainPlaylist,
                event(`/j/Audio/${trackId}/main.m3u8?PlaySessionId=audiohls1`, {
                    itemId: trackId,
                }),
            );
            expect(main.status, await main.clone().text()).toBe(200);
            const mainBody = await main.text();
            expect(mainBody).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
            expect(mainBody).toContain('#EXT-X-ENDLIST');
            expect(mainBody).not.toContain('/j/Videos/');
            const uri = mainBody.split('\n').find((l) => l.startsWith('/j/Audio/'));
            expect(uri).toMatch(
                new RegExp(
                    `^/j/Audio/${trackId}/hls1/main/segment_0+\\.ts\\?PlaySessionId=audiohls1`,
                ),
            );

            const segUrl = new URL(`http://localhost${uri}`);
            const segment = segUrl.pathname.split('/hls1/main/')[1];
            const res = await run(
                hlsSegment,
                event(`${segUrl.pathname}${segUrl.search}`, {
                    itemId: trackId,
                    playlistId: 'main',
                    segment,
                }),
            );
            expect(res.status, await res.clone().text()).toBe(200);
            const bytes = new Uint8Array(await res.arrayBuffer());
            expect(bytes.length).toBeGreaterThan(188);
            expect(bytes[0]).toBe(0x47); // MPEG-TS sync byte
        });

        it('404s a track the caller cannot see', async () => {
            const res = await run(
                masterPlaylist,
                event(`/j/Audio/${ratedId}/master.m3u8`, { itemId: ratedId }, { kid: true }),
            );
            expect(res.status).toBe(404);
        });
    });
});
