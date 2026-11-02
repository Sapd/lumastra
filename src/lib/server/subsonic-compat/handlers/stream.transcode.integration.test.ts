// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// stream.transcode.integration.test.ts
//
// Integration tests for the Subsonic /stream handler's transcode routing.
// These verify that the `format`, `maxBitRate`, and `timeOffset` query
// parameters are honored end-to-end and that direct-play remains unaffected
// when no transcoding is requested.
//
// Run locally:
//   npm run test:integration src/lib/server/subsonic-compat/handlers/stream.transcode.integration.test.ts
//
// Run against preprod:
//   npm run test:integration -- src/lib/server/subsonic-compat/handlers/stream.transcode.integration.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';

// Cache dir for transcode output during tests. Created once and torn down
// in afterAll. Each test re-builds the MusicTranscodeService singleton with
// this dir via _setServiceForTests so we never hit the production
// `/config/cache/music-transcode` path (which doesn't exist on CI/dev).
const TEST_CACHE_DIR = mkdtempSync(join(tmpdir(), 'subsonic-stream-int-'));

import { config } from '$lib/server/config.js';
import { createMusicTranscodeCache } from '$lib/server/services/music-transcode/cache.js';
import {
    MusicTranscodeService,
    _resetServiceForTests,
    _setServiceForTests,
} from '$lib/server/services/music-transcode/service.js';
import { handleStream, handleDownload } from '$lib/server/subsonic-compat/handlers/stream.js';
import { handleGetOpenSubsonicExtensions } from '$lib/server/subsonic-compat/handlers/stubs.js';
import type { SubsonicAuthContext } from '$lib/server/subsonic-compat/types.js';

import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { toUserId } from '$lib/shared/user-id.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

// users.id UUID (mig 16.46.0 — user_id columns are now uuid)
const TEST_USER = toUserId(randomUUID());
const TEST_TRACK_ID = '00000000-0000-4000-a000-00000000b001';

const __dirname_local = dirname(fileURLToPath(import.meta.url));
const FLAC_FIXTURE = resolve(__dirname_local, '../../../../../tests/fixtures/music/sample.flac');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMockEvent(params: Record<string, string>): RequestEvent {
    const url = new URL('http://localhost/rest/stream');
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }
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

function buildAuth(): SubsonicAuthContext {
    return {
        // userId is the UUID (users.id); tests pass the UUID as both fields.
        userId: TEST_USER,
        username: TEST_USER,
        ownerIsAdmin: false,
        displayName: null,
        clientName: 'integration-test',
        format: 'json',
        userGroups: [],
        maxAgeRating: null,
        isAgeRestricted: false,
    };
}

async function readToEnd(
    body: ReadableStream<Uint8Array> | null,
    timeoutMs = 30_000,
): Promise<Buffer> {
    if (!body) return Buffer.alloc(0);
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    const timer = setTimeout(() => {
        void reader.cancel('test timeout');
    }, timeoutMs);
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
        }
    } finally {
        clearTimeout(timer);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

const execFileAsync = promisify(execFile);

async function probeDurationOfBytes(bytes: Buffer): Promise<number> {
    // ffprobe over stdin (pipe:0) can't determine duration for raw mp3
    // because the stream isn't seekable. Write to a temp file and probe
    // that instead — duration counting requires seekable input for mp3.
    const tmpPath = join(
        TEST_CACHE_DIR,
        `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`,
    );
    writeFileSync(tmpPath, bytes);
    try {
        const { stdout } = await execFileAsync(config.FFPROBE_PATH, [
            '-v',
            'quiet',
            '-print_format',
            'json',
            '-show_format',
            tmpPath,
        ]);
        const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
        const d = parseFloat(parsed.format?.duration ?? '0');
        return Number.isFinite(d) ? Math.round(d * 1000) : 0;
    } finally {
        try {
            unlinkSync(tmpPath);
        } catch {
            // best-effort cleanup
        }
    }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Subsonic /stream transcode integration', () => {
    let sql: postgres.Sql;
    let trackFileId: string;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1`;

        if (!existsSync(FLAC_FIXTURE)) {
            throw new Error(
                `Required FLAC fixture missing: ${FLAC_FIXTURE}. ` +
                    `Run Task 0.1 (Add 10s FLAC test fixture) first.`,
            );
        }
    });

    afterAll(async () => {
        await closeTestDb();
        _resetServiceForTests();
        rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    });

    beforeEach(async () => {
        // Reset the music-transcode singleton, then inject a fresh service
        // backed by the temp cache dir. This bypasses the singleton getter's
        // construction path which would otherwise read
        // `config.MUSIC_TRANSCODE_CACHE_DIR` and try to create
        // `/config/cache/music-transcode` (not writable in test envs).
        _resetServiceForTests();
        _setServiceForTests(
            new MusicTranscodeService({
                sql,
                cache: createMusicTranscodeCache({ cacheDir: TEST_CACHE_DIR }),
            }),
        );

        // Truncate transcode + sessions, then re-seed media_items + media_files.
        await sql`TRUNCATE TABLE active_transcode_jobs RESTART IDENTITY CASCADE`;
        await sql`TRUNCATE TABLE play_sessions RESTART IDENTITY CASCADE`;
        await sql`
            DELETE FROM media_file_items
            WHERE media_item_id = ${TEST_TRACK_ID}::uuid
        `;
        await sql`DELETE FROM media_items WHERE id = ${TEST_TRACK_ID}::uuid`;
        // media_files.file_path has a UNIQUE constraint; clean up any prior
        // row pointing at the fixture so the re-seed below doesn't trip it.
        await sql`DELETE FROM media_files WHERE file_path = ${FLAC_FIXTURE}`;

        await ensureTestUser(sql, TEST_USER);
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (
                ${TEST_TRACK_ID}::uuid,
                'Subsonic Transcode Test Track',
                'track',
                'active'
            )
            ON CONFLICT (id) DO NOTHING
        `;

        // Insert media_files row pointing directly at the FLAC fixture path.
        // resolveMediaPath() accepts this because the file is readable.
        trackFileId = crypto.randomUUID();
        await sql`
            INSERT INTO media_files (id, file_path, created_at, updated_at)
            VALUES (
                ${trackFileId}::uuid,
                ${FLAC_FIXTURE},
                NOW(), NOW()
            )
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
            VALUES (
                ${trackFileId}::uuid,
                ${TEST_TRACK_ID}::uuid,
                true,
                0
            )
        `;
    });

    // -----------------------------------------------------------------------
    // 1. No params → direct-play (regression)
    // -----------------------------------------------------------------------

    it('direct-plays the source when no transcode params are present', async () => {
        const event = buildMockEvent({ id: TEST_TRACK_ID });
        const resp = await handleStream(event, buildAuth(), sql);

        expect(resp.status).toBe(200);
        expect(resp.headers.get('Content-Type')).toBe('audio/flac');

        const fixtureSize = statSync(FLAC_FIXTURE).size;
        expect(resp.headers.get('Content-Length')).toBe(String(fixtureSize));

        const body = await readToEnd(resp.body);
        expect(body.length).toBe(fixtureSize);
    }, 60_000);

    // -----------------------------------------------------------------------
    // 2. format=mp3 against FLAC source → transcoded mp3 body
    // -----------------------------------------------------------------------

    it('transcodes to mp3 when format=mp3 is requested against a FLAC source', async () => {
        const event = buildMockEvent({ id: TEST_TRACK_ID, format: 'mp3' });
        const resp = await handleStream(event, buildAuth(), sql);

        expect(resp.status).toBe(200);
        expect(resp.headers.get('Content-Type')).toBe('audio/mpeg');
        // Live encode → no content-length, no byte ranges.
        expect(resp.headers.get('Content-Length')).toBeNull();
        expect(resp.headers.get('Accept-Ranges')).toBe('none');

        const body = await readToEnd(resp.body);
        expect(body.length).toBeGreaterThan(0);
        // mp3 begins with an ID3 tag ('ID3') or an MP3 sync word (0xFFEx).
        const firstThree = body.subarray(0, 3).toString('ascii');
        const isMp3 = firstThree === 'ID3' || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0);
        expect(isMp3).toBe(true);
    }, 60_000);

    it.each([
        { extension: 'ogg', encoder: 'libvorbis', sourceCodec: 'vorbis', target: 'opus' },
        { extension: 'm4a', encoder: 'alac', sourceCodec: 'alac', target: 'aac' },
        { extension: 'ogg', encoder: 'libopus', sourceCodec: 'opus', target: 'opus' },
        { extension: 'm4a', encoder: 'aac', sourceCodec: 'aac', target: 'aac' },
    ])(
        'routes $sourceCodec in .$extension using the actual codec for format=$target',
        async ({ extension, encoder, sourceCodec, target }) => {
            const source = join(TEST_CACHE_DIR, `source-${sourceCodec}.${extension}`);
            await execFileAsync(config.FFMPEG_PATH, [
                '-y',
                '-i',
                FLAC_FIXTURE,
                '-c:a',
                encoder,
                source,
            ]);
            await sql`UPDATE media_files SET file_path = ${source} WHERE id = ${trackFileId}`;
            const resp = await handleStream(
                buildMockEvent({ id: TEST_TRACK_ID, format: target }),
                buildAuth(),
                sql,
            );
            expect(resp.status).toBe(200);
            const body = await readToEnd(resp.body);
            const output = join(TEST_CACHE_DIR, `output-${sourceCodec}.${extension}`);
            writeFileSync(output, body);
            const { stdout } = await execFileAsync(config.FFPROBE_PATH, [
                '-v',
                'error',
                '-select_streams',
                'a:0',
                '-show_entries',
                'stream=codec_name',
                '-of',
                'default=noprint_wrappers=1:nokey=1',
                output,
            ]);
            expect(stdout.trim()).toBe(target);
            if (sourceCodec === target) {
                expect(resp.headers.get('Content-Length')).toBe(String(statSync(source).size));
            } else {
                expect(resp.headers.get('Accept-Ranges')).toBe('none');
            }
            await sql`UPDATE media_files SET file_path = ${FLAC_FIXTURE} WHERE id = ${trackFileId}`;
        },
        60_000,
    );

    // -----------------------------------------------------------------------
    // 3. format=raw → direct-play even when other params are set
    // -----------------------------------------------------------------------

    it('format=raw forces direct-play even when maxBitRate is set', async () => {
        const event = buildMockEvent({
            id: TEST_TRACK_ID,
            format: 'raw',
            maxBitRate: '64',
        });
        const resp = await handleStream(event, buildAuth(), sql);

        expect(resp.status).toBe(200);
        expect(resp.headers.get('Content-Type')).toBe('audio/flac');
        const fixtureSize = statSync(FLAC_FIXTURE).size;
        expect(resp.headers.get('Content-Length')).toBe(String(fixtureSize));

        const body = await readToEnd(resp.body);
        expect(body.length).toBe(fixtureSize);
    }, 60_000);

    // -----------------------------------------------------------------------
    // 4. timeOffset=3 → transcoded output ≈ duration - 3s
    // -----------------------------------------------------------------------

    it('honors timeOffset by seeking the transcoded output', async () => {
        // Fixture duration is known: 10 seconds.
        const event = buildMockEvent({
            id: TEST_TRACK_ID,
            format: 'mp3',
            timeOffset: '3',
        });
        const resp = await handleStream(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        expect(resp.headers.get('Content-Type')).toBe('audio/mpeg');

        const body = await readToEnd(resp.body);
        expect(body.length).toBeGreaterThan(0);

        const outMs = await probeDurationOfBytes(body);
        // Expected ≈ 7000ms, with ~1s tolerance for mp3 framing rounding.
        expect(outMs).toBeGreaterThan(6000);
        expect(outMs).toBeLessThan(8000);
    }, 60_000);

    // -----------------------------------------------------------------------
    // 5. download endpoint always direct-plays (never transcodes)
    // -----------------------------------------------------------------------

    it('handleDownload always direct-plays even with format=mp3', async () => {
        const event = buildMockEvent({ id: TEST_TRACK_ID, format: 'mp3' });
        const resp = await handleDownload(event, buildAuth(), sql);

        expect(resp.status).toBe(200);
        expect(resp.headers.get('Content-Type')).toBe('audio/flac');
        const fixtureSize = statSync(FLAC_FIXTURE).size;
        expect(resp.headers.get('Content-Length')).toBe(String(fixtureSize));
    }, 60_000);

    // -----------------------------------------------------------------------
    // 6. getOpenSubsonicExtensions advertises transcodeOffset v1
    // -----------------------------------------------------------------------

    it('getOpenSubsonicExtensions advertises transcodeOffset v1', async () => {
        const event = buildMockEvent({});
        const resp = await handleGetOpenSubsonicExtensions(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const json = (await resp.json()) as {
            'subsonic-response': {
                openSubsonicExtensions: { name: string; versions: number[] }[];
            };
        };
        const ext = json['subsonic-response'].openSubsonicExtensions.find(
            (e) => e.name === 'transcodeOffset',
        );
        expect(ext).toBeDefined();
        expect(ext?.versions).toContain(1);
    });
});
