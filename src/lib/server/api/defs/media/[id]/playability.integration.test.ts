// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /media/{id}/playability against a real PostgreSQL database.
 *
 * Observed, not assumed: a probe leaves no play_sessions row, no playback grant
 * (hls_playback_tokens) and no watch-state or watch-history row, and an account
 * that may not see the title gets the same 404 as an absent title. Only ffprobe
 * and the path resolver are stubbed; the media, file and access queries are real.
 *
 * Run locally:
 *   npm run test:integration -- "src/lib/server/api/defs/media/[id]/playability.integration.test.ts"
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type postgres from 'postgres';

vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: vi.fn(async (path: string) => ({ isAccessible: true, containerPath: path })),
}));
vi.mock('$lib/server/utils/ffprobe.js', () => ({
    containerFromExtension: () => 'matroska',
    probeMediaFile: vi.fn(async () => ({
        success: true,
        duration: 600,
        formatBitrate: 8_000_000,
        video: {
            codec: 'hevc',
            width: 3840,
            height: 2160,
            bitrate: 8_000_000,
            hdr: 'sdr',
            pixelFormat: 'yuv420p10le',
            profile: 'Main 10',
            level: 150,
        },
        audioStreams: [
            { audioRelativeIndex: 0, absoluteIndex: 1, codec: 'eac3', channels: 6, language: 'eng', title: null, isDefault: true },
        ],
        subtitleStreams: [
            { index: 2, codec: 'subrip', language: 'eng', title: null, isDefault: false, isForced: false },
        ],
    })),
}));

import { getTestDb } from '../../../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../../../tests/integration/fixtures/user.fixtures.js';
import {
    PlayabilityRequestSchema,
    PlayabilityResponseSchema,
} from '$lib/schemas/api-playability.js';
import {
    PlaybackStartRequestSchema,
    PlaybackStartResponseSchema,
} from '$lib/schemas/playback-start.js';
import { startPlaySession } from '$lib/server/services/play-sessions.service.js';
import { connectValkey } from '$lib/server/cache/valkey.js';
import { def } from './playability.js';

const MEDIA_ID = randomUUID();
const RESTRICTED_MEDIA_ID = randomUUID();
const SERIES_ID = randomUUID();
const FILE_A = randomUUID();
const FILE_B = randomUUID();
const SIDECAR_A = randomUUID();
const SIDECAR_B = randomUUID();

describe('POST /media/{id}/playability (integration)', () => {
    let sql: postgres.Sql;
    const userId = generateTestUserId();

    beforeAll(async () => {
        sql = getTestDb();
        expect(await connectValkey()).toBe(true);
        await ensureTestUser(sql, userId);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, runtime_seconds, age_rating)
            VALUES (${MEDIA_ID}::uuid, 'Playability Fixture', 'movie', 'active', true, 600, 6),
                   (${RESTRICTED_MEDIA_ID}::uuid, 'Playability Adult Fixture', 'movie', 'active', true, 600, 18),
                   (${SERIES_ID}::uuid, 'Playability Series Fixture', 'tv', 'active', false, null, 6)
        `;
        for (const [id, path, isDefault, order] of [
            [FILE_A, '/fixture/playability/a.mkv', true, 0],
            [FILE_B, '/fixture/playability/b.mkv', false, 1],
        ] as const) {
            await sql`
                INSERT INTO media_files (id, file_path, duration_seconds, file_size_bytes)
                VALUES (${id}::uuid, ${path}, 600, 123456)
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${id}::uuid, ${MEDIA_ID}::uuid, ${isDefault}, ${order})
            `;
        }
        for (const [id, fileId, path] of [
            [SIDECAR_A, FILE_A, '/fixture/playability/a.en.srt'],
            [SIDECAR_B, FILE_B, '/fixture/playability/b.en.srt'],
        ]) {
            await sql`
                INSERT INTO external_subtitle_files (id, file_id, subtitle_path, format, language)
                VALUES (${id}::uuid, ${fileId}::uuid, ${path}, 'srt', 'eng')
            `;
        }
        await sql`
            INSERT INTO media_files (id, file_path, duration_seconds)
            VALUES (${randomUUID()}::uuid, '/fixture/playability/adult.mkv', 600)
            RETURNING id
        `.then(async ([row]) => {
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${row.id}::uuid, ${RESTRICTED_MEDIA_ID}::uuid, true, 0)
            `;
        });
    });

    afterAll(async () => {
        const items = [MEDIA_ID, RESTRICTED_MEDIA_ID, SERIES_ID];
        await sql`DELETE FROM hls_playback_tokens WHERE user_id = ${userId}::uuid`;
        await sql`DELETE FROM play_sessions WHERE user_id = ${userId}::uuid`;
        await sql`
            DELETE FROM media_files WHERE id IN (
                SELECT file_id FROM media_file_items WHERE media_item_id IN ${sql(items)}
            )
        `;
        await sql`DELETE FROM media_items WHERE id IN ${sql(items)}`;
        await sql`DELETE FROM user_profiles WHERE user_id = ${userId}::uuid`;
        await sql`DELETE FROM users WHERE id = ${userId}::uuid`;
    });

    function user(overrides: Record<string, unknown> = {}) {
        return {
            userId,
            username: 'playability-user',
            isAgeRestricted: false,
            maxAgeRating: null,
            userGroups: [],
            ...overrides,
        };
    }

    function post(id: string, body: unknown = {}, who = user()) {
        const event = { params: { id }, locals: { user: who } } as never;
        const ctx = {
            surface: 'v1',
            input: { body: PlayabilityRequestSchema.parse(body) },
        } as never;
        return def.handlers.POST!(event, ctx);
    }

    async function sideEffectCounts() {
        const [row] = await sql<{ sessions: string; grants: string; watch: string; history: string }[]>`
            SELECT
                (SELECT count(*) FROM play_sessions WHERE media_id = ${MEDIA_ID}::uuid) AS sessions,
                (SELECT count(*) FROM hls_playback_tokens WHERE user_id = ${userId}::uuid OR media_item_id = ${MEDIA_ID}::uuid) AS grants,
                (SELECT count(*) FROM user_media_state WHERE user_id = ${userId}::uuid) AS watch,
                (SELECT count(*) FROM watch_history WHERE user_id = ${userId}::uuid) AS history
        `;
        return row;
    }

    it('lists every version with the decision for the given capabilities', async () => {
        const res = await post(MEDIA_ID, {
            capabilities: { containers: ['mp4', 'ts'], videoCodecs: ['h264'], audioCodecs: ['aac'] },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.mediaId).toBe(MEDIA_ID);
        expect(body.activeFileId).toBe(FILE_A);
        expect(body.versions.map((v: { fileId: string }) => v.fileId).sort()).toEqual([FILE_A, FILE_B].sort());
        const a = body.versions.find((v: { fileId: string }) => v.fileId === FILE_A);
        expect(a).toMatchObject({ isDefault: true, playable: true, playMethod: 'full_transcode', sizeBytes: 123456 });
        expect(a.tracks.audio[0]).toMatchObject({ index: 0, absoluteIndex: 1, codec: 'eac3' });
        expect(a.tracks.subtitles[0]).toMatchObject({ index: 2, source: 'embedded', format: 'text' });
    });

    it('fileId narrows to one version and an unknown fileId is 404', async () => {
        const one = await (await post(MEDIA_ID, { fileId: FILE_B })).json();
        expect(one.versions.map((v: { fileId: string }) => v.fileId)).toEqual([FILE_B]);
        expect(one.activeFileId).toBe(FILE_B);
        expect((await post(MEDIA_ID, { fileId: randomUUID() })).status).toBe(404);
    });

    it('creates no play session, grant, watch state or watch history', async () => {
        const before = await sideEffectCounts();
        expect((await post(MEDIA_ID)).status).toBe(200);
        expect((await post(MEDIA_ID, { fileId: FILE_A })).status).toBe(200);
        expect(await sideEffectCounts()).toEqual(before);
    });

    it.each([
        { hlsCopyReload: true, expected: 'muxed' },
        { hlsCopyReload: false, expected: 'demux' },
        { hlsCopyReload: undefined, expected: 'demux' },
    ] as const)(
        'probe/start layout and subtitle ids match with hlsCopyReload=$hlsCopyReload',
        async ({ hlsCopyReload, expected }) => {
            for (const [fileId, sidecarId] of [
                [FILE_A, SIDECAR_A],
                [FILE_B, SIDECAR_B],
            ]) {
                const capabilities = {
                    containers: ['mp4', 'ts'],
                    videoCodecs: ['hevc'],
                    audioCodecs: ['eac3'],
                    subtitleFormats: ['vtt'],
                    ...(hlsCopyReload === undefined ? {} : { hlsCopyReload }),
                };
                const response = await post(MEDIA_ID, { fileId, capabilities });
                expect(response.status).toBe(200);
                const probe = PlayabilityResponseSchema.parse(await response.json());
                const started = PlaybackStartResponseSchema.parse(
                    await startPlaySession(
                        sql,
                        userId,
                        'playability-user',
                        '127.0.0.1',
                        PlaybackStartRequestSchema.parse({
                            mediaId: MEDIA_ID,
                            fileId,
                            capabilities,
                            deviceId: 'playability-parity',
                        }),
                        'native_app',
                        { surface: 'v1' },
                    ),
                );
                expect(started.kind).toBe('video');
                expect(started.delivery.kind).toBe('hls');
                if (started.delivery.kind !== 'hls') throw new Error('Expected HLS delivery');
                expect(probe.hlsAudioMode).toBe(expected);
                expect(started.delivery).toHaveProperty('hlsAudioMode', probe.hlsAudioMode);
                expect(probe.versions[0].hlsAudioMode).toBe(probe.hlsAudioMode);
                expect(started.delivery.fileId).toBe(fileId);
                expect(started.delivery.playMethod).toBe('remux');
                const ids = probe.versions[0].tracks.subtitles.map((track) => track.id).sort();
                expect(ids).toEqual([`${fileId}:2`, sidecarId].sort());
                expect(started.delivery.subtitles.map((track) => track.id).sort()).toEqual(ids);
                // Inspect the persisted plan the HLS service consumes, not just the response.
                const [{ plan_id: planId }] = await sql<{ plan_id: string }[]>`
                    SELECT plan_id FROM play_sessions WHERE id = ${started.playbackSessionId}::uuid
                `;
                const { playbackPlanner } =
                    await import('$lib/server/services/playback-planner.service.js');
                expect(await playbackPlanner.getPlan(planId)).toMatchObject({
                    delivery_path: 'native_hls',
                    hls_audio_mode: expected,
                    file_id: fileId,
                });
                await sql`DELETE FROM hls_playback_tokens WHERE user_id = ${userId}::uuid`;
                await sql`DELETE FROM play_sessions WHERE user_id = ${userId}::uuid`;
            }
        },
    );

    it('an age-restricted account gets 404 for a title above its rating, same as an absent title', async () => {
        const restricted = user({ isAgeRestricted: true, maxAgeRating: 12 });
        const hidden = await post(RESTRICTED_MEDIA_ID, {}, restricted);
        const absent = await post(randomUUID(), {}, restricted);
        expect(hidden.status).toBe(404);
        expect(absent.status).toBe(404);
        expect((await hidden.json()).code).toBe('not_found');
        // control: the same account may probe a title within its rating
        expect((await post(MEDIA_ID, {}, restricted)).status).toBe(200);
    });

    it('a series is 422 and a malformed id is 404', async () => {
        expect((await post(SERIES_ID)).status).toBe(422);
        expect((await post('not-an-id')).status).toBe(404);
    });
});
