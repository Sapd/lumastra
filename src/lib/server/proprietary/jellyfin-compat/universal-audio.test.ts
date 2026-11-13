// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    decideUniversalAudio,
    parseUniversalAudioRequest,
    progressiveTarget,
    type UniversalAudioSource,
} from './universal-audio';

// What jellyfin-web's audio player and Finamp send.
const WEB =
    'container=opus,webm|opus,ts|mp3,mp3,aac,m4a|aac,m4b|aac,flac,webma,webm|webma,wav,ogg' +
    '&transcodingContainer=ts&transcodingProtocol=hls&audioCodec=aac&maxStreamingBitrate=140000000';

function req(query: string): ReturnType<typeof parseUniversalAudioRequest> {
    return parseUniversalAudioRequest(new URLSearchParams(query));
}

function source(overrides: Partial<UniversalAudioSource> = {}): UniversalAudioSource {
    return {
        container: 'flac',
        codec: 'flac',
        bitrate: 900_000,
        sampleRate: 44_100,
        channels: 2,
        bitDepth: 16,
        ...overrides,
    };
}

describe('parseUniversalAudioRequest', () => {
    it('reads the container list with per-container codecs, case-insensitive keys', () => {
        const r = req(
            'Container=mp3,m4a|aac|alac,flac&MaxStreamingBitrate=320000&TranscodingProtocol=HLS&StartTimeTicks=50000000&PlaySessionId=ps1&DeviceId=d1',
        );
        expect(r.directPlay).toEqual([
            { family: 'mp3', codecs: ['mp3'] },
            { family: 'mp4', codecs: ['aac', 'alac'] },
            { family: 'flac', codecs: ['flac'] },
        ]);
        expect(r.maxStreamingBitrate).toBe(320_000);
        expect(r.transcodingProtocol).toBe('hls');
        expect(r.startTimeTicks).toBe(50_000_000);
        expect(r.playSessionId).toBe('ps1');
        expect(r.deviceId).toBe('d1');
    });

    it('defaults to http, no limits, and ignores garbage numbers', () => {
        const r = req('container=mp3&maxStreamingBitrate=abc&maxAudioChannels=-2');
        expect(r.transcodingProtocol).toBe('http');
        expect(r.maxStreamingBitrate).toBeNull();
        expect(r.maxAudioChannels).toBeNull();
        expect(r.startTimeTicks).toBe(0);
    });
});

describe('decideUniversalAudio', () => {
    it('direct-plays a listed container whose codec is accepted', () => {
        expect(decideUniversalAudio(req(WEB), source())).toEqual({ kind: 'direct' });
        expect(decideUniversalAudio(req(WEB), source({ container: 'm4a', codec: 'aac' }))).toEqual({
            kind: 'direct',
        });
        // .opus files are Ogg; jellyfin-web lists "ogg".
        expect(
            decideUniversalAudio(
                req('container=ogg'),
                source({ container: 'opus', codec: 'opus' }),
            ),
        ).toEqual({ kind: 'direct' });
    });

    it('a codec-named container entry implies its codec', () => {
        // `opus` alone is Ogg Opus: a Vorbis .ogg is not direct-playable for it.
        expect(
            decideUniversalAudio(
                req('container=opus'),
                source({ container: 'ogg', codec: 'vorbis' }),
            ).kind,
        ).not.toBe('direct');
        expect(
            decideUniversalAudio(
                req('container=opus'),
                source({ container: 'ogg', codec: 'opus' }),
            ),
        ).toEqual({ kind: 'direct' });
        expect(
            decideUniversalAudio(
                req('container=opus'),
                source({ container: 'opus', codec: 'opus' }),
            ),
        ).toEqual({ kind: 'direct' });
        // `flac` alone does not take an ALAC-in-whatever mislabelled as flac family.
        expect(
            decideUniversalAudio(req('container=flac'), source({ codec: 'alac' })).kind,
        ).not.toBe('direct');
        // An explicit codec list still wins over the implied one.
        expect(
            decideUniversalAudio(
                req('container=ogg|vorbis'),
                source({ container: 'ogg', codec: 'vorbis' }),
            ),
        ).toEqual({ kind: 'direct' });
        // A plain `ogg` entry takes any Ogg audio.
        expect(
            decideUniversalAudio(
                req('container=ogg'),
                source({ container: 'ogg', codec: 'vorbis' }),
            ),
        ).toEqual({ kind: 'direct' });
    });

    it('QuickTime and 3GP are not the mp4 family', () => {
        for (const container of ['mov', '3gp']) {
            expect(
                decideUniversalAudio(req('container=mp4,m4a'), source({ container, codec: 'aac' }))
                    .kind,
                container,
            ).not.toBe('direct');
        }
        expect(
            decideUniversalAudio(req('container=mp4'), source({ container: 'm4b', codec: 'aac' })),
        ).toEqual({ kind: 'direct' });
    });

    it('a codec the container entry does not accept is not direct play', () => {
        // m4a listed with aac only; an ALAC m4a needs a transcode.
        const d = decideUniversalAudio(req(WEB), source({ container: 'm4a', codec: 'alac' }));
        expect(d).toEqual({ kind: 'hls', audioCodec: 'aac' });
    });

    it('limits over the source force a transcode; unknown values pass', () => {
        expect(
            decideUniversalAudio(req('container=flac&maxStreamingBitrate=320000'), source()).kind,
        ).toBe('progressive');
        expect(
            decideUniversalAudio(
                req('container=flac&maxAudioSampleRate=44100'),
                source({ sampleRate: 96_000 }),
            ).kind,
        ).toBe('progressive');
        expect(
            decideUniversalAudio(
                req('container=flac&maxAudioBitDepth=16'),
                source({ bitDepth: 24 }),
            ).kind,
        ).toBe('progressive');
        expect(
            decideUniversalAudio(
                req('container=flac&maxStreamingBitrate=320000'),
                source({ bitrate: null }),
            ),
        ).toEqual({ kind: 'direct' });
    });

    it('HLS copies the audio when only the container was unsupported and TS can carry it', () => {
        const d = decideUniversalAudio(
            req('container=mp3|mp3,aac&transcodingProtocol=hls'),
            source({ container: 'mkv', codec: 'mp3' }),
        );
        expect(d).toEqual({ kind: 'hls', audioCodec: 'copy' });
    });

    it('HLS encodes a codec MPEG-TS cannot carry even when only the container failed', () => {
        const d = decideUniversalAudio(
            req('container=mp3,ogg|flac&transcodingProtocol=hls'),
            source({ container: 'flac', codec: 'flac' }),
        );
        expect(d).toEqual({ kind: 'hls', audioCodec: 'aac' });
    });

    it('progressive transcode: target from transcodingContainer, bitrate from audioBitRate', () => {
        expect(
            decideUniversalAudio(
                req(
                    'container=mp3&transcodingContainer=mp3&audioCodec=mp3&audioBitRate=192000&maxStreamingBitrate=999999',
                ),
                source(),
            ),
        ).toEqual({ kind: 'progressive', codec: 'mp3', bitrate: 192_000 });
        // No container list at all: nothing is direct-playable (Jellyfin too).
        expect(decideUniversalAudio(req(''), source({ container: 'mp3', codec: 'mp3' }))).toEqual({
            kind: 'progressive',
            codec: 'mp3',
            bitrate: null,
        });
    });
});

describe('progressiveTarget', () => {
    it.each([
        ['transcodingContainer=mp3', 'mp3'],
        ['transcodingContainer=aac', 'aac'],
        ['transcodingContainer=m4a&audioCodec=aac', 'm4a'],
        ['transcodingContainer=mp4', 'm4a'],
        ['transcodingContainer=ogg&audioCodec=opus', 'opus'],
        ['transcodingContainer=ts&audioCodec=aac', 'aac'],
        ['transcodingContainer=webm&audioCodec=opus', 'opus'],
        ['transcodingContainer=flac&audioCodec=flac', 'mp3'],
        ['audioCodec=aac', 'aac'],
        ['', 'mp3'],
    ])('%s → %s', (query, codec) => {
        expect(progressiveTarget(req(query))).toBe(codec);
    });
});
