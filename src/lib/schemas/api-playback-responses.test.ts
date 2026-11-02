// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { CurrentSessionSchema } from './api-sessions-responses';
import { AdminPlaySessionSchema } from './api-admin-responses';
import {
    LumastraInfoResponseSchema,
    LumastraPlayMethodSchema,
    SessionHeartbeatResponseSchema,
} from '$lib/schemas/api-playback-responses';

// A genuinely valid LumastraInfoResponse shape (only the fields the schema
// requires — everything else is optional/defaulted), with an `audio_only`
// key added to `play_methods`. This must survive the REAL schema parse —
// `play_methods` is a fixed-key z.object, so if `audio_only` isn't declared
// there, Zod silently strips it even though the enum accepts the value.
const fullValidInfoResponseWithAudioOnly = {
    playable: true,
    recommended: 'direct',
    output_hdr: 'sdr',
    transcode_codec: null,
    resume_position_ms: 0,
    resume_anchor: null,
    is_watched: false,
    duration_ms: 120000,
    active_file_id: 'file-1',
    subtitles: [],
    tracks: {
        video: null,
        audio: [],
        subtitles: [],
    },
    play_methods: {
        direct: { url: 'https://example/direct', available: true },
        remux: { url: 'https://example/remux', available: true },
        audio_transcode: { url: 'https://example/audio-transcode', available: true },
        full_transcode: { url: 'https://example/full-transcode', available: true },
        audio_only: {
            url: 'https://example/hls?videoCodec=none&audioCodec=aac',
            available: true,
        },
    },
    versions: [],
};

describe('audio_only survives the real response schema', () => {
    it('is a valid play method', () => {
        expect(LumastraPlayMethodSchema.safeParse('audio_only').success).toBe(true);
    });

    it('is NOT stripped from play_methods on parse', () => {
        const parsed = LumastraInfoResponseSchema.parse(fullValidInfoResponseWithAudioOnly);
        expect(parsed.play_methods.audio_only).toEqual({ available: true });
    });

    it('is accepted as the top-level `recommended` value on the real schema', () => {
        // recommended is typed as LumastraPlayMethodSchema — a widened enum
        // alone would be pointless if the field using it still rejected the
        // value, so round-trip it through the full response too.
        const parsed = LumastraInfoResponseSchema.parse({
            ...fullValidInfoResponseWithAudioOnly,
            recommended: 'audio_only',
        });
        expect(parsed.recommended).toBe('audio_only');
    });
});

describe('TranscodeProgressPayloadSchema — hdrTonemapMode', () => {
    it('survives the real heartbeat response schema when set to software', () => {
        const heartbeat = {
            resumeAnchorAt: '1970-01-01T00:00:12.345Z',
            progressSaved: true,
            transcode: {
                progressPercent: 50,
                segmentsReady: 5,
                totalSegments: 10,
                elapsedSeconds: 30,
                hdrTonemapMode: 'software',
            },
        };

        const parsed = SessionHeartbeatResponseSchema.parse(heartbeat);
        expect(parsed.transcode?.hdrTonemapMode).toBe('software');
    });

    it('rejects an hdrTonemapMode value outside the known enum', () => {
        const heartbeat = {
            resumeAnchorAt: null,
            progressSaved: false,
            transcode: {
                progressPercent: 0,
                segmentsReady: 0,
                totalSegments: 0,
                elapsedSeconds: 0,
                hdrTonemapMode: 'bogus',
            },
        };

        expect(SessionHeartbeatResponseSchema.safeParse(heartbeat).success).toBe(false);
    });
});

describe('playback info is a description', () => {
    it('does not expose method or external-subtitle delivery URLs', () => {
        const parsed = LumastraInfoResponseSchema.parse({
            ...fullValidInfoResponseWithAudioOnly,
            externalSubtitles: [
                {
                    id: 'sub-1',
                    language: 'en',
                    format: 'srt',
                    isForced: false,
                    isSdh: false,
                    deliveryUrl: '/api/playback/item/subtitles/external/sub-1?api_key=secret',
                },
            ],
        });
        for (const method of Object.values(parsed.play_methods)) {
            expect(method).toEqual({ available: true });
        }
        expect(parsed.externalSubtitles?.[0]).toEqual({
            id: 'sub-1',
            language: 'en',
            format: 'srt',
            isForced: false,
            isSdh: false,
        });
        expect(JSON.stringify(parsed)).not.toMatch(/https?:|deliveryUrl|api_key|stream_token/);
    });
});

it('retains client diagnostic metadata in session response contracts', () => {
    const diagnostics = { clientVersion: '1.0.1 (2610140823)', userAgent: 'Apple agent' };
    expect(
        CurrentSessionSchema.parse({
            title: 'Book',
            mediaType: 'audiobook',
            state: 'playing',
            progress: 0,
            currentTime: 0,
            duration: 100,
            clientName: 'Apple',
            ...diagnostics,
        }),
    ).toMatchObject(diagnostics);
    expect(
        AdminPlaySessionSchema.parse({
            __id: 'session',
            username: 'tester',
            title: 'Book',
            clientname: 'Apple',
            browsername: 'Apple',
            clientVersion: diagnostics.clientVersion,
            user_agent_raw: diagnostics.userAgent,
        }),
    ).toMatchObject({
        clientVersion: diagnostics.clientVersion,
        user_agent_raw: diagnostics.userAgent,
    });
});

describe('heartbeat clock anchor', () => {
    it('requires the explicitly named ISO anchor field', () => {
        expect(
            SessionHeartbeatResponseSchema.safeParse({
                resume_anchor: 123,
                progressSaved: false,
            }).success,
        ).toBe(false);
        const parsed = SessionHeartbeatResponseSchema.parse({
            resumeAnchorAt: '1970-01-01T00:00:00.123Z',
            progressSaved: false,
        });
        expect(parsed.resumeAnchorAt).toBe('1970-01-01T00:00:00.123Z');
        expect(parsed).not.toHaveProperty('resume_anchor');
    });
});
