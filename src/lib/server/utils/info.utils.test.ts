// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { convertJellyfinProfile, isPlayable, parseCapsAuto } from './info.utils.js';

// Helper to build a minimal Jellyfin DeviceProfile body
function profileBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        DeviceProfile: {
            DirectPlayProfiles: [
                {
                    Container: 'mp4,m4v',
                    Type: 'Video',
                    VideoCodec: 'h264,hevc',
                    AudioCodec: 'aac,ac3',
                },
            ],
            TranscodingProfiles: [{ AudioCodec: 'aac,ac3' }],
            CodecProfiles: [],
            ...overrides,
        },
    };
}

describe('isPlayable', () => {
    it('direct is always playable regardless of HLS', () => {
        expect(isPlayable('direct', true)).toBe(true);
        expect(isPlayable('direct', false)).toBe(true);
    });

    it('remux is playable when HLS is available', () => {
        expect(isPlayable('remux', true)).toBe(true);
    });

    it('remux is not playable when HLS is unavailable', () => {
        expect(isPlayable('remux', false)).toBe(false);
    });

    it('audio_transcode is playable when HLS is available', () => {
        expect(isPlayable('audio_transcode', true)).toBe(true);
    });

    it('audio_transcode is not playable when HLS is unavailable', () => {
        expect(isPlayable('audio_transcode', false)).toBe(false);
    });

    it('full_transcode is playable when HLS is available', () => {
        expect(isPlayable('full_transcode', true)).toBe(true);
    });

    it('full_transcode is not playable when HLS is unavailable', () => {
        expect(isPlayable('full_transcode', false)).toBe(false);
    });

    it('returns false for unknown recommendation value', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(isPlayable('unknown_method' as any, true)).toBe(false);
    });
});

describe('convertJellyfinProfile', () => {
    it('returns undefined when DeviceProfile is missing', () => {
        expect(convertJellyfinProfile({})).toBeUndefined();
    });

    it('returns undefined when DirectPlayProfiles is missing', () => {
        expect(convertJellyfinProfile({ DeviceProfile: {} })).toBeUndefined();
    });

    it('accepts camelCase deviceProfile (public API schema)', () => {
        const body = {
            deviceProfile: {
                DirectPlayProfiles: [
                    {
                        Container: 'mp4',
                        Type: 'Video',
                        VideoCodec: 'h264',
                        AudioCodec: 'aac',
                    },
                ],
            },
        };
        const caps = convertJellyfinProfile(body);
        expect(caps).toBeDefined();
        expect(caps!.videoCodecs).toEqual(new Set(['h264']));
    });

    it("normalizes the 'h265' alias to 'hevc' (ffprobe's canonical name)", () => {
        const body = {
            deviceProfile: {
                DirectPlayProfiles: [
                    {
                        Container: 'mp4',
                        Type: 'Video',
                        VideoCodec: 'h264,h265',
                        AudioCodec: 'aac',
                    },
                ],
            },
        };
        const caps = convertJellyfinProfile(body);
        expect(caps).toBeDefined();
        expect(caps!.videoCodecs).toEqual(new Set(['h264', 'hevc']));
    });

    it('extracts basic video/audio codecs and containers', () => {
        const caps = convertJellyfinProfile(profileBody());
        expect(caps).toBeDefined();
        expect(caps!.videoCodecs).toEqual(new Set(['h264', 'hevc']));
        expect(caps!.audioCodecs).toEqual(new Set(['aac', 'ac3']));
        expect(caps!.containers).toEqual(new Set(['mp4', 'm4v']));
    });

    it('extracts HLS audio codecs from TranscodingProfiles', () => {
        const caps = convertJellyfinProfile(profileBody());
        expect(caps!.hlsAudioCodecs).toEqual(new Set(['aac', 'ac3']));
    });

    // ── MaxStreamingBitrate ────────────────────────────────

    it('extracts MaxStreamingBitrate as maxBitrate', () => {
        const caps = convertJellyfinProfile(profileBody({ MaxStreamingBitrate: 120000000 }));
        expect(caps!.maxBitrate).toBe(120000000);
    });

    it('ignores MaxStreamingBitrate when zero or negative', () => {
        expect(
            convertJellyfinProfile(profileBody({ MaxStreamingBitrate: 0 }))!.maxBitrate,
        ).toBeUndefined();
        expect(
            convertJellyfinProfile(profileBody({ MaxStreamingBitrate: -1 }))!.maxBitrate,
        ).toBeUndefined();
    });

    it('ignores MaxStreamingBitrate when not a number', () => {
        expect(
            convertJellyfinProfile(profileBody({ MaxStreamingBitrate: '120000000' }))!.maxBitrate,
        ).toBeUndefined();
    });

    // ── VideoLevel extraction ──────────────────────────────

    it('extracts VideoLevel per-codec from a single Video CodecProfile', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Codec: 'h264',
                        Conditions: [
                            {
                                Condition: 'LessThanEqual',
                                Property: 'VideoLevel',
                                Value: '52',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(caps!.codecConstraints).toEqual({ h264: { maxLevel: 52 } });
        // Flat field should not be set when using per-codec constraints
        expect(caps!.maxVideoLevel).toBeUndefined();
    });

    it('stores per-codec VideoLevel separately (not flattened)', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Codec: 'h264',
                        Conditions: [
                            {
                                Condition: 'LessThanEqual',
                                Property: 'VideoLevel',
                                Value: '52',
                            },
                        ],
                    },
                    {
                        Type: 'Video',
                        Codec: 'hevc',
                        Conditions: [
                            {
                                Condition: 'LessThanEqual',
                                Property: 'VideoLevel',
                                Value: '153',
                            },
                        ],
                    },
                ],
            }),
        );
        // Each codec keeps its own level — no flattening
        expect(caps!.codecConstraints?.h264?.maxLevel).toBe(52);
        expect(caps!.codecConstraints?.hevc?.maxLevel).toBe(153);
    });

    it('extracts VideoProfile per-codec from CodecProfile conditions', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Codec: 'h264',
                        Conditions: [
                            {
                                Condition: 'EqualsAny',
                                Property: 'VideoProfile',
                                Value: 'high|main|baseline',
                            },
                        ],
                    },
                    {
                        Type: 'Video',
                        Codec: 'hevc',
                        Conditions: [
                            {
                                Condition: 'EqualsAny',
                                Property: 'VideoProfile',
                                Value: 'main|main 10',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(caps!.codecConstraints?.h264?.maxProfile).toBe('high|main|baseline');
        expect(caps!.codecConstraints?.hevc?.maxProfile).toBe('main|main 10');
    });

    it('extracts NotEquals VideoProfile as excludedProfiles', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Codec: 'h264',
                        Conditions: [
                            {
                                Condition: 'NotEquals',
                                Property: 'VideoProfile',
                                Value: 'High 10',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(caps!.codecConstraints?.h264?.excludedProfiles).toBe('High 10');
    });

    it('accumulates multiple NotEquals VideoProfile conditions', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Codec: 'h264',
                        Conditions: [
                            {
                                Condition: 'NotEquals',
                                Property: 'VideoProfile',
                                Value: 'High 10',
                            },
                            {
                                Condition: 'NotEquals',
                                Property: 'VideoProfile',
                                Value: 'High 4:2:2',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(caps!.codecConstraints?.h264?.excludedProfiles).toBe('High 10|High 4:2:2');
    });

    it('ignores VideoLevel conditions that are not LessThanEqual', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Conditions: [
                            {
                                Condition: 'GreaterThanEqual',
                                Property: 'VideoLevel',
                                Value: '10',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(caps!.codecConstraints).toBeUndefined();
    });

    it('ignores VideoLevel on non-Video CodecProfiles', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'VideoAudio',
                        Conditions: [
                            {
                                Condition: 'LessThanEqual',
                                Property: 'VideoLevel',
                                Value: '41',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(caps!.codecConstraints).toBeUndefined();
    });

    // ── AudioChannels extraction ───────────────────────────

    it('extracts AudioChannels from VideoAudio CodecProfile', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'VideoAudio',
                        Codec: 'aac',
                        Conditions: [
                            {
                                Condition: 'LessThanEqual',
                                Property: 'AudioChannels',
                                Value: '8',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(caps!.maxAudioChannels).toBe(8);
    });

    it('uses most restrictive AudioChannels across multiple codecs', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'VideoAudio',
                        Codec: 'aac',
                        Conditions: [
                            {
                                Condition: 'LessThanEqual',
                                Property: 'AudioChannels',
                                Value: '8',
                            },
                        ],
                    },
                    {
                        Type: 'VideoAudio',
                        Codec: 'ac3,eac3',
                        Conditions: [
                            {
                                Condition: 'LessThanEqual',
                                Property: 'AudioChannels',
                                Value: '6',
                            },
                        ],
                    },
                ],
            }),
        );
        // Most restrictive = 6
        expect(caps!.maxAudioChannels).toBe(6);
    });

    it('extracts AudioChannels from Audio type CodecProfiles too', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'Audio',
                        Conditions: [
                            {
                                Condition: 'LessThanEqual',
                                Property: 'AudioChannels',
                                Value: '2',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(caps!.maxAudioChannels).toBe(2);
    });

    // ── HDR formats extraction ─────────────────────────────

    it('extracts HDR formats from supportsHdr flag', () => {
        const caps = convertJellyfinProfile(profileBody({ supportsHdr: true }));
        expect(caps!.hdrFormats).toContain('hdr10');
        expect(caps!.hdrFormats).toContain('hlg');
    });

    it('extracts DV from supportsDolbyVision flag', () => {
        const caps = convertJellyfinProfile(profileBody({ supportsDolbyVision: true }));
        expect(caps!.hdrFormats).toContain('dovi');
    });

    it('extracts HDR formats from VideoRangeType conditions', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Conditions: [
                            {
                                Condition: 'EqualsAny',
                                Property: 'VideoRangeType',
                                Value: 'SDR|HDR10|HLG|DOVI|DOVIWithHDR10',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(caps!.hdrFormats).toContain('hdr10');
        expect(caps!.hdrFormats).toContain('hlg');
        expect(caps!.hdrFormats).toContain('dovi');
    });

    // Regression: 'DOVIWithHDR10'/'DOVIWithHLG'/'DOVIWithSDR' tokens mean the
    // device plays the HDR10/HLG/SDR BASE LAYER of a Profile-8-style DV
    // bitstream only — NOT real Dolby Vision decode. Only a bare 'DOVI' (or
    // 'DolbyVision') token means the client can actually decode DV. Treating
    // 'DOVIWith*' as DV support would ship an un-decodable DV P5 bitstream to
    // a client that can only handle the base layer.
    it('DOVIWithHDR10 (base-layer-only token) contributes hdr10 but NOT dovi', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Conditions: [
                            {
                                Condition: 'EqualsAny',
                                Property: 'VideoRangeType',
                                Value: 'SDR|DOVIWithHDR10|HDR10',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(caps!.hdrFormats).toContain('hdr10');
        expect(caps!.hdrFormats).not.toContain('dovi');
    });

    it('bare DOVI token (real DV decode) contributes dovi', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Conditions: [
                            {
                                Condition: 'EqualsAny',
                                Property: 'VideoRangeType',
                                Value: 'SDR|DOVI|HDR10',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(caps!.hdrFormats).toContain('dovi');
    });

    // ── Apple TV profile shape (real-world integration) ────

    it('handles Apple TV-like profile with all constraint types', () => {
        const caps = convertJellyfinProfile({
            DeviceProfile: {
                MaxStreamingBitrate: 120000000,
                DirectPlayProfiles: [
                    {
                        Container: 'mp4,m4v,mov',
                        Type: 'Video',
                        VideoCodec: 'h264,hevc',
                        AudioCodec: 'aac,ac3,eac3,alac',
                    },
                ],
                TranscodingProfiles: [{ AudioCodec: 'aac,ac3,eac3' }],
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Codec: 'h264',
                        Conditions: [
                            {
                                Condition: 'EqualsAny',
                                Property: 'VideoProfile',
                                Value: 'high|main|baseline|constrained baseline',
                            },
                            {
                                Condition: 'EqualsAny',
                                Property: 'VideoRangeType',
                                Value: 'SDR',
                            },
                            {
                                Condition: 'LessThanEqual',
                                Property: 'VideoLevel',
                                Value: '52',
                            },
                        ],
                    },
                    {
                        Type: 'Video',
                        Codec: 'hevc',
                        Conditions: [
                            {
                                Condition: 'EqualsAny',
                                Property: 'VideoProfile',
                                Value: 'main|main 10',
                            },
                            {
                                Condition: 'EqualsAny',
                                Property: 'VideoRangeType',
                                Value: 'SDR|HDR10|HLG|DOVI|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR',
                            },
                            {
                                Condition: 'LessThanEqual',
                                Property: 'VideoLevel',
                                Value: '153',
                            },
                        ],
                    },
                    {
                        Type: 'VideoAudio',
                        Codec: 'aac',
                        Conditions: [
                            {
                                Condition: 'LessThanEqual',
                                Property: 'AudioChannels',
                                Value: '8',
                            },
                        ],
                    },
                    {
                        Type: 'VideoAudio',
                        Codec: 'ac3,eac3',
                        Conditions: [
                            {
                                Condition: 'LessThanEqual',
                                Property: 'AudioChannels',
                                Value: '6',
                            },
                        ],
                    },
                ],
            },
        });

        expect(caps).toBeDefined();
        expect(caps!.videoCodecs).toEqual(new Set(['h264', 'hevc']));
        expect(caps!.audioCodecs).toEqual(new Set(['aac', 'ac3', 'eac3', 'alac']));
        expect(caps!.maxBitrate).toBe(120000000);
        // Per-codec levels — not flattened
        expect(caps!.codecConstraints?.h264?.maxLevel).toBe(52);
        expect(caps!.codecConstraints?.hevc?.maxLevel).toBe(153);
        expect(caps!.codecConstraints?.h264?.maxProfile).toBe(
            'high|main|baseline|constrained baseline',
        );
        expect(caps!.codecConstraints?.hevc?.maxProfile).toBe('main|main 10');
        // Most restrictive channels: min(8, 6) = 6
        expect(caps!.maxAudioChannels).toBe(6);
        // HDR from HEVC VideoRangeType conditions
        expect(caps!.hdrFormats).toContain('hdr10');
        expect(caps!.hdrFormats).toContain('hlg');
        expect(caps!.hdrFormats).toContain('dovi');
    });

    // ── Edge cases ─────────────────────────────────────────

    it('returns undefined when no video codecs in DirectPlayProfiles', () => {
        const caps = convertJellyfinProfile({
            DeviceProfile: {
                DirectPlayProfiles: [{ Container: 'mp3', Type: 'Audio' }],
            },
        });
        expect(caps).toBeUndefined();
    });

    it('handles empty CodecProfiles array', () => {
        const caps = convertJellyfinProfile(profileBody({ CodecProfiles: [] }));
        expect(caps!.codecConstraints).toBeUndefined();
        expect(caps!.maxAudioChannels).toBeUndefined();
    });

    it('handles missing Conditions array in CodecProfile', () => {
        const caps = convertJellyfinProfile(
            profileBody({
                CodecProfiles: [{ Type: 'Video', Codec: 'h264' }],
            }),
        );
        expect(caps!.codecConstraints).toBeUndefined();
    });
});

describe('parseCapsAuto', () => {
    it('requires explicit copy-HLS reload support from upgraded native clients', () => {
        const caps = 'v:h264,hevc;a:aac,ac3;c:mp4,mov,ts';
        expect(parseCapsAuto(`${caps};hr:1`)?.deviceCaps.supportsHlsCopyReload).toBe(true);
        for (const suffix of ['', ';hr:0', ';hr:true', ';hr:2']) {
            expect(parseCapsAuto(caps + suffix)?.deviceCaps.supportsHlsCopyReload).toBeUndefined();
        }
    });

    it('reads the separate-audio preference (da:1) from both caps formats', () => {
        const flat = 'v:h264,hevc;a:aac,ac3;c:mp4';
        expect(parseCapsAuto(`${flat};da:1`)?.deviceCaps.prefersHlsDemuxAudio).toBe(true);
        expect(parseCapsAuto(flat)?.deviceCaps.prefersHlsDemuxAudio).toBeUndefined();
        expect(parseCapsAuto(`${flat};da:0`)?.deviceCaps.prefersHlsDemuxAudio).toBeUndefined();

        const ps = 'ps:df={v:h264;a:aac;c:mp4},nh={v:h264,hevc;a:aac,ac3},mh={v:h264;a:aac}';
        const parsed = parseCapsAuto(`${ps};as:1;da:1;mc:6`);
        expect(parsed?.deviceCaps.prefersHlsDemuxAudio).toBe(true);
        expect(parsed?.pathScoped?.hlsDemuxAudio).toBe(true);
        expect(parsed?.deviceCaps.maxAudioChannels).toBe(6);
        expect(parseCapsAuto(`${ps};as:1`)?.deviceCaps.prefersHlsDemuxAudio).toBeUndefined();
    });

    it('detects and parses flat format', () => {
        const result = parseCapsAuto('v:h264,hevc;a:aac,opus;c:mp4;as:1');
        expect(result).toBeDefined();
        expect(result!.deviceCaps.videoCodecs.has('h264')).toBe(true);
        expect(result!.pathScoped).toBeUndefined();
    });

    it('detects and parses path-scoped format', () => {
        const result = parseCapsAuto(
            'ps:df={v:h264,hevc;a:aac;c:mp4,webm},nh={v:h264,hevc;a:aac,ac3},mh={v:h264,vp9;a:aac,opus}',
        );
        expect(result).toBeDefined();
        expect(result!.pathScoped).toBeDefined();
        expect(result!.pathScoped!.directFile.videoCodecs).toContain('h264');
        expect(result!.pathScoped!.directFile.videoCodecs).toContain('hevc');
        expect(result!.pathScoped!.directFile.containers).toContain('mp4');
        expect(result!.pathScoped!.nativeHls.audioCodecs).toContain('ac3');
        expect(result!.pathScoped!.mseHls.videoCodecs).toContain('vp9');
    });

    it('returns undefined for null input', () => {
        expect(parseCapsAuto(null)).toBeUndefined();
    });

    it('path-scoped format produces valid DeviceCapabilities (union of all paths)', () => {
        const result = parseCapsAuto(
            'ps:df={v:h264;a:aac;c:mp4},nh={v:hevc;a:ac3},mh={v:vp9;a:opus}',
        );
        const caps = result!.deviceCaps;
        expect(caps.videoCodecs.has('h264')).toBe(true);
        expect(caps.videoCodecs.has('hevc')).toBe(true);
        expect(caps.videoCodecs.has('vp9')).toBe(true);
        expect(caps.audioCodecs.has('aac')).toBe(true);
        expect(caps.audioCodecs.has('opus')).toBe(true);
    });

    it('Safari HEVC in directFile and nativeHls but not necessarily mseHls', () => {
        const result = parseCapsAuto(
            'ps:df={v:h264,hevc;a:aac;c:mp4},nh={v:h264,hevc;a:aac,ac3,eac3},mh={v:h264;a:aac}',
        );
        const ps = result!.pathScoped!;
        expect(ps.directFile.videoCodecs).toContain('hevc');
        expect(ps.nativeHls.videoCodecs).toContain('hevc');
        expect(ps.mseHls.videoCodecs).not.toContain('hevc');
    });

    it('No MKV in directFile containers', () => {
        const result = parseCapsAuto(
            'ps:df={v:h264;a:aac;c:mp4,webm},nh={v:;a:},mh={v:h264;a:aac}',
        );
        expect(result!.pathScoped!.directFile.containers).not.toContain('mkv');
    });

    it('AC3/EAC3 only in nativeHls, not mseHls', () => {
        const result = parseCapsAuto(
            'ps:df={v:h264;a:aac;c:mp4},nh={v:h264;a:aac,ac3,eac3},mh={v:h264;a:aac,opus}',
        );
        const ps = result!.pathScoped!;
        expect(ps.nativeHls.audioCodecs).toContain('ac3');
        expect(ps.nativeHls.audioCodecs).toContain('eac3');
        expect(ps.mseHls.audioCodecs).not.toContain('ac3');
    });

    it('trailing params (legacy comma-separated): hdr, audio switching, max channels, codec constraints', () => {
        const result = parseCapsAuto(
            'ps:df={v:h264;a:aac;c:mp4},nh={v:;a:},mh={v:h264;a:aac},h:hdr10,as:1,mc:8,cc:h264:52',
        );
        const ps = result!.pathScoped!;
        expect(ps.hdr.decode).toContain('hdr10');
        expect(ps.audioSwitching).toBe(true);
        expect(ps.maxChannels).toBe(8);
        expect(ps.codecConstraints['h264']?.maxLevel).toBe(52);
    });

    it('trailing params (new semicolon-separated): multi-value HDR and codec constraints preserved', () => {
        const result = parseCapsAuto(
            'ps:df={v:h264;a:aac;c:mp4},nh={v:h264;a:aac},mh={v:h264;a:aac};h:hdr10,hlg;as:1;mc:6;cc:h264:52,hevc:186',
        );
        const ps = result!.pathScoped!;
        expect(ps.hdr.decode).toContain('hdr10');
        expect(ps.hdr.decode).toContain('hlg');
        expect(ps.audioSwitching).toBe(true);
        expect(ps.maxChannels).toBe(6);
        expect(ps.codecConstraints['h264']?.maxLevel).toBe(52);
        expect(ps.codecConstraints['hevc']?.maxLevel).toBe(186);
    });
});
