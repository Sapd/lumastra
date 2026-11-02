// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '$lib/server/config.js';
import { decide, type ClientInfo, type SourceMetadata } from './decision.js';

const flacSrc: SourceMetadata = {
    container: 'flac',
    codec: 'flac',
    bitrate: 1000000, // 1000 kbps (lossless)
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
};

const mp3Src: SourceMetadata = {
    container: 'mp3',
    codec: 'mp3',
    bitrate: 320000, // 320 kbps
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
};

describe('decide', () => {
    it('direct-plays when source matches a directPlayProfile', () => {
        const client: ClientInfo = {
            name: 'TestClient',
            platform: 'iOS',
            directPlayProfiles: [{ container: 'mp3', codec: 'mp3' }],
            transcodingProfiles: [],
        };
        const result = decide(client, mp3Src);
        expect(result.canDirectPlay).toBe(true);
        expect(result.canTranscode).toBe(false);
        expect(result.chosenTarget).toBeNull();
    });

    it('transcodes when no direct-play profile matches', () => {
        const client: ClientInfo = {
            name: 'TestClient',
            platform: 'iOS',
            directPlayProfiles: [{ container: 'mp3', codec: 'mp3' }],
            transcodingProfiles: [{ container: 'mp3', codec: 'mp3' }],
            maxAudioBitrate: 192,
        };
        const result = decide(client, flacSrc);
        expect(result.canDirectPlay).toBe(false);
        expect(result.canTranscode).toBe(true);
        expect(result.chosenTarget).toEqual({
            codec: 'mp3',
            container: 'mp3',
            bitrate: 192,
        });
        expect(result.transcodeReason).toContain('container_mismatch');
    });

    it('honors maxAudioBitrate when no maxTranscodingAudioBitrate', () => {
        const client: ClientInfo = {
            name: 'TestClient',
            platform: 'iOS',
            directPlayProfiles: [],
            transcodingProfiles: [{ container: 'mp3', codec: 'mp3' }],
            maxAudioBitrate: 128,
        };
        const result = decide(client, flacSrc);
        expect(result.chosenTarget?.bitrate).toBe(128);
    });

    it('returns canTranscode=false when no transcodingProfile matches', () => {
        const client: ClientInfo = {
            name: 'NoCompat',
            platform: 'X',
            directPlayProfiles: [],
            transcodingProfiles: [{ container: 'aiff', codec: 'pcm_s16le' }],
        };
        const result = decide(client, flacSrc);
        expect(result.canDirectPlay).toBe(false);
        expect(result.canTranscode).toBe(false);
    });

    it('prefers opus over mp3 when both supported and source is lossless', () => {
        const client: ClientInfo = {
            name: 'TestClient',
            platform: 'Android',
            directPlayProfiles: [],
            transcodingProfiles: [
                { container: 'mp3', codec: 'mp3' },
                { container: 'ogg', codec: 'opus' },
            ],
        };
        const result = decide(client, flacSrc);
        // We bias toward opus when both are available (better q/bitrate).
        expect(result.chosenTarget?.codec).toBe('opus');
    });

    it('refuses to decide when source codec is unknown', () => {
        // ffprobe couldn't determine the codec — emitting a transcode target
        // here would spawn ffmpeg against a file with no audio stream.
        const client: ClientInfo = {
            name: 'TestClient',
            platform: 'iOS',
            directPlayProfiles: [{ container: 'mp3', codec: 'mp3' }],
            transcodingProfiles: [
                { container: 'mp3', codec: 'mp3' },
                { container: 'ogg', codec: 'opus' },
            ],
        };
        const unknownSrc: SourceMetadata = {
            container: 'unknown',
            codec: 'unknown',
            bitrate: 0,
            sampleRate: 0,
            channels: 0,
            bitDepth: 0,
        };
        const result = decide(client, unknownSrc);
        expect(result.canDirectPlay).toBe(false);
        expect(result.canTranscode).toBe(false);
        expect(result.chosenTarget).toBeNull();
        expect(result.transcodeReason).toContain('source_unprobed');
    });

    it('does not match a transcoding profile by container alone', () => {
        // Profile lists ogg+vorbis. Opus is also ogg-containered but the
        // client only decodes Vorbis-in-Ogg; codec-only matching prevents the
        // wire-protocol mismatch.
        const client: ClientInfo = {
            name: 'TestClient',
            platform: 'Linux',
            directPlayProfiles: [],
            transcodingProfiles: [{ container: 'ogg', codec: 'vorbis' }],
        };
        const result = decide(client, flacSrc);
        expect(result.canTranscode).toBe(false);
        expect(result.chosenTarget).toBeNull();
    });
});

/**
 * With no bitrate from the client, the target bitrate is
 * MUSIC_TRANSCODE_DEFAULT_BITRATE snapped to the codec's ladder. Until
 * 2026-10-06 it was a per-codec literal and the admin setting did nothing.
 */
describe('decide: MUSIC_TRANSCODE_DEFAULT_BITRATE', () => {
    afterEach(() => vi.restoreAllMocks());

    function noBitrateClient(codec: string): ClientInfo {
        return {
            name: 'TestClient',
            platform: 'iOS',
            directPlayProfiles: [],
            transcodingProfiles: [{ container: codec, codec }],
        };
    }

    it.each([
        ['mp3', 128, 128],
        ['mp3', 320, 320],
        ['aac', 256, 256],
        // The opus ladder stops at 192.
        ['opus', 320, 192],
        // Between rungs: the largest rung below the setting.
        ['mp3', 200, 192],
    ])('%s at a %i kbps setting transcodes at %i kbps', (codec, setting, expected) => {
        vi.spyOn(config, 'MUSIC_TRANSCODE_DEFAULT_BITRATE', 'get').mockReturnValue(setting);
        const result = decide(noBitrateClient(codec), flacSrc);
        expect(result.chosenTarget?.bitrate).toBe(expected);
    });

    it('a client bitrate still wins over the setting', () => {
        vi.spyOn(config, 'MUSIC_TRANSCODE_DEFAULT_BITRATE', 'get').mockReturnValue(320);
        const result = decide({ ...noBitrateClient('mp3'), maxAudioBitrate: 128 }, flacSrc);
        expect(result.chosenTarget?.bitrate).toBe(128);
    });
});
