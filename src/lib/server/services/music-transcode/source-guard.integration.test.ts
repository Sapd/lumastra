// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ruling T7-music (fix plan 6, Task 7 fix round 5): the music-transcode spawn
 * refuses a source whose content is a playlist/manifest body. This covers
 * music rows linked before the scanner learned to sniff: such a row stays
 * linked until an operator retires it, and without this guard
 * `-protocol_whitelist file -i <track>` follows ffconcat → `.m3u8` → an
 * absolute path into another directory and plays the foreign track.
 *
 * Real Postgres, real files and the real ffmpeg: the service seam
 * (`MusicTranscodeService.streamFor`) and one real HTTP caller (Subsonic
 * `/stream`).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';

import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { toUserId } from '$lib/shared/user-id.js';
import { createMusicTranscodeCache } from './cache.js';
import { MusicTranscodeService, _resetServiceForTests, _setServiceForTests } from './service.js';
import type { TranscodeStreamRequest } from './types.js';
import { handleStream } from '$lib/server/subsonic-compat/handlers/stream.js';
import type { SubsonicAuthContext } from '$lib/server/subsonic-compat/types.js';

const execFileAsync = promisify(execFile);
const __dirname_local = dirname(fileURLToPath(import.meta.url));
const FLAC_FIXTURE = resolve(__dirname_local, '../../../../../tests/fixtures/music/sample.flac');

const TEST_USER = toUserId(randomUUID());
const PLAYLIST_TRACK = '00000000-0000-4000-a000-00000000c001';
const REAL_TRACK = '00000000-0000-4000-a000-00000000c002';

async function readToEnd(body: ReadableStream<Uint8Array> | null): Promise<Buffer> {
    if (!body) return Buffer.alloc(0);
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function buildEvent(params: Record<string, string>): RequestEvent {
    const url = new URL('http://localhost/rest/stream');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return {
        url,
        request: new Request(url.toString()),
        locals: { subsonicBodyParams: new URLSearchParams() },
        params: {},
        route: { id: '/rest/stream' as const },
        cookies: {} as RequestEvent['cookies'],
        fetch: globalThis.fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => {},
    } as unknown as RequestEvent;
}

const auth: SubsonicAuthContext = {
    userId: TEST_USER,
    username: TEST_USER,
    ownerIsAdmin: false,
    displayName: null,
    clientName: 'source-guard-test',
    format: 'json',
    userGroups: [],
    maxAgeRating: null,
    isAgeRestricted: false,
};

describe('music transcode refuses a playlist-body source (real PG, real ffmpeg)', () => {
    let sql: postgres.Sql;
    let dir: string;
    let cacheDir: string;
    let playlistTrack: string;
    let service: MusicTranscodeService;

    beforeAll(async () => {
        sql = getTestDb();
        if (!existsSync(FLAC_FIXTURE)) throw new Error(`missing fixture ${FLAC_FIXTURE}`);
        dir = mkdtempSync(join(tmpdir(), 'music-source-guard-'));
        // The chain the reviewer reproduced: 01.mp3 is an ffconcat script whose
        // one entry is an HLS playlist whose one segment is a track OUTSIDE
        // the library.
        const foreign = join(dir, 'other-library-foreign.mp3');
        await execFileAsync('ffmpeg', [
            '-v',
            'error',
            '-y',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:duration=3',
            '-c:a',
            'libmp3lame',
            foreign,
        ]);
        writeFileSync(
            join(dir, 'v.m3u8'),
            `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\n${foreign}\n#EXT-X-ENDLIST\n`,
        );
        playlistTrack = join(dir, '01.mp3');
        writeFileSync(playlistTrack, 'ffconcat version 1.0\nfile v.m3u8\n');
    });

    afterAll(async () => {
        _resetServiceForTests();
        await closeTestDb();
        rmSync(dir, { recursive: true, force: true });
        if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        cacheDir = mkdtempSync(join(tmpdir(), 'music-source-guard-cache-'));
        _resetServiceForTests();
        service = new MusicTranscodeService({
            sql,
            cache: createMusicTranscodeCache({ cacheDir }),
        });
        _setServiceForTests(service);

        await sql`TRUNCATE TABLE active_transcode_jobs RESTART IDENTITY CASCADE`;
        await sql`TRUNCATE TABLE play_sessions RESTART IDENTITY CASCADE`;
        for (const id of [PLAYLIST_TRACK, REAL_TRACK]) {
            await sql`DELETE FROM media_file_items WHERE media_item_id = ${id}::uuid`;
            await sql`DELETE FROM media_items WHERE id = ${id}::uuid`;
        }
        await sql`DELETE FROM media_files WHERE file_path IN (${playlistTrack}, ${FLAC_FIXTURE})`;
        await ensureTestUser(sql, TEST_USER);

        // A LINKED pre-fix row for each file, as an old scan would have left it.
        for (const [id, path] of [
            [PLAYLIST_TRACK, playlistTrack],
            [REAL_TRACK, FLAC_FIXTURE],
        ] as const) {
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${id}::uuid, 'Source Guard Track', 'track', 'active')
            `;
            const fileId = randomUUID();
            await sql`INSERT INTO media_files (id, file_path) VALUES (${fileId}::uuid, ${path})`;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${fileId}::uuid, ${id}::uuid, true, 0)
            `;
        }
    });

    async function sessionFor(trackId: string): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO play_sessions (media_id, user_id, device_id, ip_address, play_method, position_ms)
            VALUES (${trackId}::uuid, ${TEST_USER}, 'source-guard', '127.0.0.1'::inet, 'audio_transcode', 0)
            RETURNING id
        `;
        return row.id;
    }

    function request(
        trackId: string,
        sourcePath: string,
        sessionId: string,
    ): TranscodeStreamRequest {
        return {
            trackUuid: trackId,
            sourcePath,
            sourceMtimeMs: statSync(sourcePath).mtimeMs,
            codec: 'mp3',
            bitrateKbps: 128,
            timeOffset: 0,
            session: { sessionId, userId: TEST_USER, deviceId: 'source-guard', source: 'subsonic' },
        };
    }

    it('service: streamFor refuses the playlist body with status 415 and spawns nothing', async () => {
        const sessionId = await sessionFor(PLAYLIST_TRACK);

        await expect(
            service.streamFor(request(PLAYLIST_TRACK, playlistTrack, sessionId)),
        ).rejects.toMatchObject({ status: 415 });

        const jobs =
            await sql`SELECT 1 FROM active_transcode_jobs WHERE play_session_id = ${sessionId}`;
        expect(jobs).toHaveLength(0);
    }, 60_000);

    it('control: service streamFor still encodes a real track', async () => {
        const sessionId = await sessionFor(REAL_TRACK);
        const result = await service.streamFor(request(REAL_TRACK, FLAC_FIXTURE, sessionId));
        expect((await readToEnd(result.body)).length).toBeGreaterThan(0);
    }, 60_000);

    it('Subsonic /stream: a linked pre-fix playlist row is refused with HTTP 415', async () => {
        const resp = await handleStream(
            buildEvent({ id: PLAYLIST_TRACK, format: 'opus' }),
            auth,
            sql,
        );
        await readToEnd(resp.body);
        expect(resp.status).toBe(415);
    }, 60_000);

    it('control: Subsonic /stream still transcodes a real track', async () => {
        const resp = await handleStream(buildEvent({ id: REAL_TRACK, format: 'mp3' }), auth, sql);
        expect(resp.status).toBe(200);
        expect((await readToEnd(resp.body)).length).toBeGreaterThan(0);
    }, 60_000);
});
