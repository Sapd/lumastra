// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// transcode.integration.test.ts
//
// Integration tests for the OpenSubsonic transcoding extension handlers
// (getTranscodeDecision + getTranscodeStream).
//
// Verifies:
//   - getOpenSubsonicExtensions advertises `transcoding` v1
//   - direct-play-compatible profile → canDirectPlay=true, transcodeParams=null
//   - bitrate-capped FLAC client → canTranscode=true, transcodeParams non-null
//   - getTranscodeStream with valid token emits correct codec bytes
//   - getTranscodeStream rejects mediaId mismatch (error 70)
//   - getTranscodeStream rejects tampered signature (error 70)
//   - getTranscodeStream rejects expired token (error 70)
//
// Run locally:
//   npm run test:integration src/lib/server/subsonic-compat/handlers/transcode.integration.test.ts
//
// Run against preprod:
//   npm run test:integration -- src/lib/server/subsonic-compat/handlers/transcode.integration.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';

const TEST_CACHE_DIR = mkdtempSync(join(tmpdir(), 'subsonic-transcode-int-'));

import { createMusicTranscodeCache } from '$lib/server/services/music-transcode/cache.js';
import {
    MusicTranscodeService,
    _resetServiceForTests,
    _setServiceForTests,
} from '$lib/server/services/music-transcode/service.js';
import { signTranscodeToken } from '$lib/server/services/music-transcode/token.js';
import {
    handleGetTranscodeDecision,
    handleGetTranscodeStream,
} from '$lib/server/subsonic-compat/handlers/transcode.js';
import { handleGetOpenSubsonicExtensions } from '$lib/server/subsonic-compat/handlers/stubs.js';
import type { SubsonicAuthContext } from '$lib/server/subsonic-compat/types.js';

import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

// users.id UUID (mig 16.46.0 — user_id columns are now uuid)
const TEST_USER: UserId = toUserId(randomUUID());
const TEST_TRACK_ID = '00000000-0000-4000-a000-00000000c001';

const __dirname_local = dirname(fileURLToPath(import.meta.url));
const FLAC_FIXTURE = resolve(__dirname_local, '../../../../../tests/fixtures/music/sample.flac');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BuildEventOpts {
    params?: Record<string, string>;
    method?: 'GET' | 'POST';
    body?: unknown;
}

function buildMockEvent(opts: BuildEventOpts = {}): RequestEvent {
    const { params = {}, method = 'GET', body } = opts;
    const url = new URL('http://localhost/rest/getTranscode');
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }
    const init: RequestInit = { method };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { 'Content-Type': 'application/json' };
    }
    return {
        url,
        request: new Request(url.toString(), init),
        locals: { subsonicBodyParams: new URLSearchParams() },
        params: {},
        route: { id: '/rest/transcode' as const },
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

interface SubsonicEnvelope<T> {
    'subsonic-response': T;
}

interface TranscodeDecisionPayload {
    status: 'ok' | 'failed';
    transcodeDecision?: {
        canDirectPlay: boolean;
        canTranscode: boolean;
        transcodeReason: string[];
        transcodeParams: string | null;
        sourceStream: Record<string, unknown>;
        transcodeStream: Record<string, unknown> | null;
    };
    error?: { code: number; message: string };
}

async function readDecision(resp: Response): Promise<TranscodeDecisionPayload> {
    const json = (await resp.json()) as SubsonicEnvelope<TranscodeDecisionPayload>;
    return json['subsonic-response'];
}

// FLAC source profile — matches what `probeAudioSource` returns for the
// fixture (container='flac', codec='flac'). Used to build direct-play and
// transcode-only ClientInfos.
const FLAC_DIRECT_PROFILE = {
    containers: ['flac'],
    audioCodecs: ['flac'],
};
const MP3_TRANSCODE_PROFILE = {
    container: 'mp3',
    audioCodec: 'mp3',
    protocol: 'http' as const,
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('OpenSubsonic transcoding extension', () => {
    let sql: postgres.Sql;

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
        _resetServiceForTests();
        _setServiceForTests(
            new MusicTranscodeService({
                sql,
                cache: createMusicTranscodeCache({ cacheDir: TEST_CACHE_DIR }),
            }),
        );

        await sql`TRUNCATE TABLE active_transcode_jobs RESTART IDENTITY CASCADE`;
        await sql`TRUNCATE TABLE play_sessions RESTART IDENTITY CASCADE`;
        await sql`
            DELETE FROM media_file_items
            WHERE media_item_id = ${TEST_TRACK_ID}::uuid
        `;
        await sql`DELETE FROM media_items WHERE id = ${TEST_TRACK_ID}::uuid`;
        await sql`DELETE FROM media_files WHERE file_path = ${FLAC_FIXTURE}`;

        await ensureTestUser(sql, TEST_USER);
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (
                ${TEST_TRACK_ID}::uuid,
                'Subsonic Transcode Extension Test Track',
                'track',
                'active'
            )
            ON CONFLICT (id) DO NOTHING
        `;

        const trackFileId = crypto.randomUUID();
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
    // 1. Extensions list
    // -----------------------------------------------------------------------

    it('advertises transcoding v1 in getOpenSubsonicExtensions', async () => {
        const event = buildMockEvent();
        const resp = await handleGetOpenSubsonicExtensions(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const json = (await resp.json()) as {
            'subsonic-response': {
                openSubsonicExtensions: { name: string; versions: number[] }[];
            };
        };
        const ext = json['subsonic-response'].openSubsonicExtensions.find(
            (e) => e.name === 'transcoding',
        );
        expect(ext).toBeDefined();
        expect(ext?.versions).toContain(1);
    });

    // -----------------------------------------------------------------------
    // 2. Direct-play decision
    // -----------------------------------------------------------------------

    it('returns canDirectPlay=true and no transcodeParams for a FLAC-capable client', async () => {
        const event = buildMockEvent({
            params: { mediaId: TEST_TRACK_ID, mediaType: 'song' },
            method: 'POST',
            body: {
                name: 'test-client',
                platform: 'test',
                directPlayProfiles: [FLAC_DIRECT_PROFILE],
                transcodingProfiles: [MP3_TRANSCODE_PROFILE],
            },
        });
        const resp = await handleGetTranscodeDecision(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const payload = await readDecision(resp);
        expect(payload.status).toBe('ok');
        expect(payload.transcodeDecision?.canDirectPlay).toBe(true);
        expect(payload.transcodeDecision?.canTranscode).toBe(false);
        expect(payload.transcodeDecision?.transcodeParams).toBeNull();
        expect(payload.transcodeDecision?.sourceStream.codec).toBe('flac');
    }, 60_000);

    // -----------------------------------------------------------------------
    // 3. Transcode decision (bitrate cap)
    // -----------------------------------------------------------------------

    it('returns canTranscode=true with a signed transcodeParams when bitrate cap forces transcode', async () => {
        // FLAC fixture's source bitrate is ~105 kbps (lossless),
        // so a 100 kbps cap triggers transcoding even though the container/codec is
        // listed as a direct-play profile.
        const event = buildMockEvent({
            params: { mediaId: TEST_TRACK_ID, mediaType: 'song' },
            method: 'POST',
            body: {
                name: 'test-client',
                platform: 'test',
                directPlayProfiles: [FLAC_DIRECT_PROFILE],
                transcodingProfiles: [MP3_TRANSCODE_PROFILE],
                maxAudioBitrate: 100, // kbps (OpenSubsonic spec) — below FLAC fixture's ~105 kbps
            },
        });
        const resp = await handleGetTranscodeDecision(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const payload = await readDecision(resp);
        expect(payload.status).toBe('ok');
        expect(payload.transcodeDecision?.canTranscode).toBe(true);
        expect(payload.transcodeDecision?.transcodeParams).toBeTruthy();
        expect(typeof payload.transcodeDecision?.transcodeParams).toBe('string');
        expect(payload.transcodeDecision?.transcodeStream?.codec).toBe('mp3');
    }, 60_000);

    // -----------------------------------------------------------------------
    // 4. Missing mediaId → error 10
    // -----------------------------------------------------------------------

    it('returns error 10 when mediaId is missing', async () => {
        const event = buildMockEvent({
            params: { mediaType: 'song' },
            method: 'POST',
            body: {
                name: 'x',
                platform: 'x',
                directPlayProfiles: [],
                transcodingProfiles: [],
            },
        });
        const resp = await handleGetTranscodeDecision(event, buildAuth(), sql);
        const payload = await readDecision(resp);
        expect(payload.status).toBe('failed');
        expect(payload.error?.code).toBe(10);
    });

    // -----------------------------------------------------------------------
    // 5. Unsupported mediaType → error 0
    // -----------------------------------------------------------------------

    it('returns error 0 for unsupported mediaType (e.g. podcast)', async () => {
        const event = buildMockEvent({
            params: { mediaId: TEST_TRACK_ID, mediaType: 'podcast' },
            method: 'POST',
            body: {
                name: 'x',
                platform: 'x',
                directPlayProfiles: [],
                transcodingProfiles: [],
            },
        });
        const resp = await handleGetTranscodeDecision(event, buildAuth(), sql);
        const payload = await readDecision(resp);
        expect(payload.status).toBe('failed');
        expect(payload.error?.code).toBe(0);
    });

    // -----------------------------------------------------------------------
    // 6. Missing body → error 10
    // -----------------------------------------------------------------------

    it('returns error 10 when the request body is not a JSON object', async () => {
        // GET request (no body) — readClientInfoBody returns null.
        const event = buildMockEvent({
            params: { mediaId: TEST_TRACK_ID, mediaType: 'song' },
            method: 'GET',
        });
        const resp = await handleGetTranscodeDecision(event, buildAuth(), sql);
        const payload = await readDecision(resp);
        expect(payload.status).toBe('failed');
        expect(payload.error?.code).toBe(10);
    });

    // -----------------------------------------------------------------------
    // 7. End-to-end: decision → stream (mp3 codec output)
    // -----------------------------------------------------------------------

    it('end-to-end: getTranscodeDecision token round-trips through getTranscodeStream and emits mp3 bytes', async () => {
        // Phase 1: request decision.
        const decisionEvent = buildMockEvent({
            params: { mediaId: TEST_TRACK_ID, mediaType: 'song' },
            method: 'POST',
            body: {
                name: 'test-client',
                platform: 'test',
                directPlayProfiles: [FLAC_DIRECT_PROFILE],
                transcodingProfiles: [MP3_TRANSCODE_PROFILE],
                maxAudioBitrate: 100, // kbps (OpenSubsonic spec) — below FLAC fixture's ~105 kbps
            },
        });
        const decisionResp = await handleGetTranscodeDecision(decisionEvent, buildAuth(), sql);
        const decision = await readDecision(decisionResp);
        expect(decision.status).toBe('ok');
        const token = decision.transcodeDecision?.transcodeParams;
        expect(token).toBeTruthy();

        // Phase 2: feed the token into getTranscodeStream.
        const streamEvent = buildMockEvent({
            params: {
                mediaId: TEST_TRACK_ID,
                mediaType: 'song',
                transcodeParams: token as string,
            },
            method: 'GET',
        });
        const streamResp = await handleGetTranscodeStream(streamEvent, buildAuth(), sql);
        expect(streamResp.status).toBe(200);
        expect(streamResp.headers.get('Content-Type')).toBe('audio/mpeg');
        expect(streamResp.headers.get('Accept-Ranges')).toBe('none');

        const body = await readToEnd(streamResp.body);
        expect(body.length).toBeGreaterThan(0);
        // mp3 begins with an ID3 tag ('ID3') or an MP3 sync word (0xFFEx).
        const firstThree = body.subarray(0, 3).toString('ascii');
        const isMp3 = firstThree === 'ID3' || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0);
        expect(isMp3).toBe(true);
    }, 60_000);

    // -----------------------------------------------------------------------
    // 8. getTranscodeStream rejects tampered signature
    // -----------------------------------------------------------------------

    it('rejects a tampered transcodeParams signature with error 70', async () => {
        // Sign a valid token, then flip a character in the signature half.
        const valid = signTranscodeToken({
            v: 1,
            mid: TEST_TRACK_ID,
            mt: 'song',
            c: 'mp3',
            ct: 'mp3',
            br: 128,
            fp: 'abcdef0123456789',
            exp: Math.floor(Date.now() / 1000) + 3600,
        });
        const [body, sig] = valid.split('.');
        // Flip the first sig char to a different base64-url-safe char.
        const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
        const tampered = `${body}.${flipped}`;

        const event = buildMockEvent({
            params: {
                mediaId: TEST_TRACK_ID,
                mediaType: 'song',
                transcodeParams: tampered,
            },
            method: 'GET',
        });
        const resp = await handleGetTranscodeStream(event, buildAuth(), sql);
        const payload = await readDecision(resp);
        expect(payload.status).toBe('failed');
        expect(payload.error?.code).toBe(70);
    }, 60_000);

    // -----------------------------------------------------------------------
    // 9. getTranscodeStream rejects mediaId mismatch
    // -----------------------------------------------------------------------

    it('rejects a token signed for a different mediaId with error 70', async () => {
        const token = signTranscodeToken({
            v: 1,
            mid: '00000000-0000-4000-a000-deadbeefdead',
            mt: 'song',
            c: 'mp3',
            ct: 'mp3',
            br: 128,
            fp: 'abcdef0123456789',
            exp: Math.floor(Date.now() / 1000) + 3600,
        });
        const event = buildMockEvent({
            params: {
                mediaId: TEST_TRACK_ID,
                mediaType: 'song',
                transcodeParams: token,
            },
            method: 'GET',
        });
        const resp = await handleGetTranscodeStream(event, buildAuth(), sql);
        const payload = await readDecision(resp);
        expect(payload.status).toBe('failed');
        expect(payload.error?.code).toBe(70);
        expect(payload.error?.message).toMatch(/mediaId_mismatch/);
    }, 60_000);

    // -----------------------------------------------------------------------
    // 10. getTranscodeStream rejects expired token
    // -----------------------------------------------------------------------

    it('rejects an expired transcodeParams with error 70', async () => {
        const token = signTranscodeToken({
            v: 1,
            mid: TEST_TRACK_ID,
            mt: 'song',
            c: 'mp3',
            ct: 'mp3',
            br: 128,
            fp: 'abcdef0123456789',
            exp: Math.floor(Date.now() / 1000) - 10, // 10s in the past
        });
        const event = buildMockEvent({
            params: {
                mediaId: TEST_TRACK_ID,
                mediaType: 'song',
                transcodeParams: token,
            },
            method: 'GET',
        });
        const resp = await handleGetTranscodeStream(event, buildAuth(), sql);
        const payload = await readDecision(resp);
        expect(payload.status).toBe('failed');
        expect(payload.error?.code).toBe(70);
        expect(payload.error?.message).toMatch(/expired/);
    });

    // -----------------------------------------------------------------------
    // 11. getTranscodeStream rejects stale fingerprint
    // -----------------------------------------------------------------------

    it('rejects a token whose fingerprint does not match the source (error 70)', async () => {
        // Forge a valid signature but with a bogus fingerprint — the handler
        // re-probes the source and the fingerprint won't match.
        const token = signTranscodeToken({
            v: 1,
            mid: TEST_TRACK_ID,
            mt: 'song',
            c: 'mp3',
            ct: 'mp3',
            br: 128,
            fp: 'baadbeefdeadc0de', // not what the handler will compute
            exp: Math.floor(Date.now() / 1000) + 3600,
        });
        const event = buildMockEvent({
            params: {
                mediaId: TEST_TRACK_ID,
                mediaType: 'song',
                transcodeParams: token,
            },
            method: 'GET',
        });
        const resp = await handleGetTranscodeStream(event, buildAuth(), sql);
        const payload = await readDecision(resp);
        expect(payload.status).toBe('failed');
        expect(payload.error?.code).toBe(70);
        expect(payload.error?.message).toMatch(/Source file changed/);
    }, 60_000);
});
