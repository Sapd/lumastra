// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for HLS Master Playlist generation
 */

import { describe, it, expect } from 'vitest';
import {
    generateMuxedMasterPlaylist,
    generateMasterPlaylist,
    generateAudioOnlyMasterPlaylist,
    AUDIO_ONLY_BANDWIDTH,
    calculateEstimatedBandwidth,
    isNativeHlsClient,
    resolveSyntheticIframes,
    type MasterPlaylistVideoInfo,
    type MasterPlaylistTrickplayInfo,
    resolveHevcMain10,
} from './hls-master-playlist.js';
import type { AudioTrackInfo, SubtitleTrackInfo } from './hls-audio-injection.js';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';

describe('generateMasterPlaylist', () => {
    const baseAudioTracks: AudioTrackInfo[] = [
        {
            index: asAbsoluteStreamIndex(0),
            language: 'ger',
            displayTitle: 'German 2.0',
            channels: 2,
            codec: 'aac',
            isDefault: true,
        },
        {
            index: asAbsoluteStreamIndex(1),
            language: 'eng',
            displayTitle: 'English 5.1',
            channels: 6,
            codec: 'aac',
            isDefault: false,
        },
    ];

    const baseVideoInfo: MasterPlaylistVideoInfo = {
        codec: 'hevc',
        width: 1920,
        height: 1080,
        bitrate: 20000000,
    };

    it('should generate basic master playlist with audio tracks', () => {
        const playlist = generateMasterPlaylist(
            baseAudioTracks,
            undefined,
            '/segment',
            new URLSearchParams(),
            25000000,
            baseVideoInfo,
        );

        expect(playlist).toContain('#EXTM3U');
        expect(playlist).toContain('#EXT-X-VERSION:7');
        expect(playlist).toContain('TYPE=AUDIO');
        expect(playlist).toContain('LANGUAGE="ger"');
        expect(playlist).toContain('LANGUAGE="eng"');
        expect(playlist).toContain('stream_0/index.m3u8'); // First audio
        expect(playlist).toContain('stream_1/index.m3u8'); // Second audio
        expect(playlist).toContain('stream_2/index.m3u8'); // Video (after 2 audio tracks)
    });

    it('should set correct default audio track', () => {
        const playlist = generateMasterPlaylist(
            baseAudioTracks,
            undefined,
            '/segment',
            new URLSearchParams(),
            25000000,
            baseVideoInfo,
        );

        // German (index 0) should be DEFAULT=YES
        expect(playlist).toMatch(/LANGUAGE="ger"[^#]*DEFAULT=YES/);
        // English (index 1) should be DEFAULT=NO
        expect(playlist).toMatch(/LANGUAGE="eng"[^#]*DEFAULT=NO/);
    });

    it('marks the client-selected audio track as the only DEFAULT', () => {
        const playlist = generateMasterPlaylist(
            baseAudioTracks,
            undefined,
            '/segment',
            new URLSearchParams(),
            25000000,
            baseVideoInfo,
            undefined,
            undefined,
            undefined,
            undefined,
            { selectedAudioStreamIndex: 1 },
        );

        expect(playlist).toMatch(/LANGUAGE="ger"[^#]*DEFAULT=NO/);
        expect(playlist).toMatch(/LANGUAGE="eng"[^#]*DEFAULT=YES/);
    });

    it('keeps the file defaults when the selected index matches no audio track', () => {
        // 0 is what an outdated tab sends; absolute 0 is usually the video stream.
        const tracks = baseAudioTracks.map((t, i) => ({
            ...t,
            index: asAbsoluteStreamIndex(i + 1),
        }));
        const playlist = generateMasterPlaylist(
            tracks,
            undefined,
            '/segment',
            new URLSearchParams(),
            25000000,
            baseVideoInfo,
            undefined,
            undefined,
            undefined,
            undefined,
            { selectedAudioStreamIndex: 0 },
        );

        expect(playlist).toMatch(/LANGUAGE="ger"[^#]*DEFAULT=YES/);
        expect(playlist).toMatch(/LANGUAGE="eng"[^#]*DEFAULT=NO/);
    });

    describe('audio rendition DEFAULT and NAME', () => {
        const audioLines = (playlist: string): string[] =>
            playlist.split('\n').filter((line) => line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO'));
        const build = (
            tracks: AudioTrackInfo[],
            options?: { selectedAudioStreamIndex?: number },
        ): string =>
            generateMasterPlaylist(
                tracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                undefined,
                undefined,
                undefined,
                undefined,
                options,
            );
        const track = (index: number, overrides: Partial<AudioTrackInfo> = {}): AudioTrackInfo => ({
            index: asAbsoluteStreamIndex(index),
            displayTitle: '',
            language: 'und',
            channels: 2,
            codec: 'aac',
            isDefault: false,
            ...overrides,
        });

        it('marks exactly one rendition DEFAULT=YES when the file flags several as default', () => {
            const lines = audioLines(
                build([
                    track(1, { language: 'eng', displayTitle: 'English', isDefault: true }),
                    track(2, { language: 'ger', displayTitle: 'German', isDefault: true }),
                ]),
            );
            expect(lines).toHaveLength(2);
            expect(lines.filter((l) => l.includes('DEFAULT=YES'))).toHaveLength(1);
            expect(lines[0]).toContain('DEFAULT=YES');
            expect(lines[1]).toContain('DEFAULT=NO');
        });

        it('falls back to the first rendition when the file flags none as default', () => {
            const lines = audioLines(
                build([
                    track(1, { language: 'eng', displayTitle: 'English' }),
                    track(2, { language: 'ger', displayTitle: 'German' }),
                ]),
            );
            expect(lines.filter((l) => l.includes('DEFAULT=YES'))).toHaveLength(1);
            expect(lines[0]).toContain('DEFAULT=YES');
        });

        it('keeps the client-selected rendition as the only DEFAULT=YES', () => {
            const lines = audioLines(
                build(
                    [
                        track(1, { language: 'eng', displayTitle: 'English', isDefault: true }),
                        track(2, { language: 'ger', displayTitle: 'German', isDefault: true }),
                    ],
                    { selectedAudioStreamIndex: 2 },
                ),
            );
            expect(lines.filter((l) => l.includes('DEFAULT=YES'))).toHaveLength(1);
            expect(lines[1]).toContain('DEFAULT=YES');
        });

        it('names an untitled track after its language, and keeps AUTOSELECT=YES', () => {
            const lines = audioLines(build([track(1, { language: 'eng', displayTitle: '' })]));
            expect(lines[0]).toContain('NAME="English"');
            expect(lines[0]).toContain('AUTOSELECT=YES');
        });

        it('replaces a title that only repeats the language code or und', () => {
            const lines = audioLines(
                build([
                    track(1, { language: 'eng', displayTitle: 'eng' }),
                    track(2, { language: 'ger', displayTitle: 'und' }),
                ]),
            );
            expect(lines[0]).toContain('NAME="English"');
            expect(lines[1]).toContain('NAME="German"');
        });

        it('numbers untitled tracks of unknown language as Audio N', () => {
            const lines = audioLines(build([track(1), track(2)]));
            expect(lines[0]).toContain('NAME="Audio 1"');
            expect(lines[1]).toContain('NAME="Audio 2"');
        });

        it('keeps a real title as the NAME', () => {
            const lines = audioLines(
                build([track(1, { language: 'eng', displayTitle: 'Director Commentary' })]),
            );
            expect(lines[0]).toContain('NAME="Director_Commentary"');
        });

        // Apple's players label an AUTOSELECT=YES rendition with the language
        // name and ignore NAME (HLS draft, Appendix E.2); only the first
        // rendition of a language keeps AUTOSELECT=YES, the rest carry a NAME
        // the player shows as written.
        it('describes the further renditions of a language by codec and layout', () => {
            const lines = audioLines(
                build([
                    track(1, { language: 'eng', displayTitle: '', codec: 'ac3' }),
                    track(2, { language: 'eng', displayTitle: '', codec: 'dts', channels: 6 }),
                    track(3, { language: 'eng', displayTitle: '', codec: 'ac3' }),
                ]),
            );
            expect(lines[0]).toContain('NAME="English",DEFAULT=YES,AUTOSELECT=YES');
            expect(lines[1]).toContain('NAME="English (DTS 5.1)",DEFAULT=NO,AUTOSELECT=NO');
            expect(lines[2]).toContain('NAME="English (AC3)",DEFAULT=NO,AUTOSELECT=NO');
        });

        it('numbers renditions that still share a NAME', () => {
            const lines = audioLines(
                build([
                    track(1, { language: 'eng', displayTitle: '', codec: 'ac3' }),
                    track(2, { language: 'eng', displayTitle: '', codec: 'ac3' }),
                    track(3, { language: 'eng', displayTitle: '', codec: 'ac3' }),
                ]),
            );
            expect(lines[0]).toContain('NAME="English"');
            expect(lines[1]).toContain('NAME="English (AC3)"');
            expect(lines[2]).toContain('NAME="English (AC3) 2"');
        });

        it('makes the client-selected rendition the primary of its language', () => {
            const lines = audioLines(
                build(
                    [
                        track(1, {
                            language: 'ger',
                            displayTitle: '',
                            codec: 'ac3',
                            isDefault: true,
                        }),
                        track(2, { language: 'eng', displayTitle: '', codec: 'ac3' }),
                        track(3, { language: 'eng', displayTitle: '', codec: 'dts', channels: 6 }),
                    ],
                    { selectedAudioStreamIndex: 3 },
                ),
            );
            expect(lines[0]).toContain('NAME="German",DEFAULT=NO,AUTOSELECT=YES');
            expect(lines[1]).toContain('NAME="English (AC3)",DEFAULT=NO,AUTOSELECT=NO');
            expect(lines[2]).toContain('NAME="English",DEFAULT=YES,AUTOSELECT=YES');
        });

        it('keeps a real title on a further rendition and only drops its AUTOSELECT', () => {
            const lines = audioLines(
                build([
                    track(1, { language: 'eng', displayTitle: '', codec: 'ac3' }),
                    track(2, {
                        language: 'eng',
                        displayTitle: 'Director Commentary',
                        codec: 'ac3',
                    }),
                ]),
            );
            expect(lines[1]).toContain('NAME="Director_Commentary",DEFAULT=NO,AUTOSELECT=NO');
        });

        it('leaves single renditions of different languages AUTOSELECT=YES', () => {
            const lines = audioLines(
                build([
                    track(1, { language: 'ger', displayTitle: '' }),
                    track(2, { language: 'eng', displayTitle: '' }),
                ]),
            );
            expect(lines.every((l) => l.includes('AUTOSELECT=YES'))).toBe(true);
        });
    });

    it('should include correct channel count', () => {
        const playlist = generateMasterPlaylist(
            baseAudioTracks,
            undefined,
            '/segment',
            new URLSearchParams(),
            25000000,
            baseVideoInfo,
        );

        expect(playlist).toContain('CHANNELS="2"'); // German stereo
        expect(playlist).toContain('CHANNELS="6"'); // English 5.1
    });

    describe('HDR VIDEO-RANGE support', () => {
        it('should include VIDEO-RANGE=PQ for HDR10 content', () => {
            const hdr10VideoInfo: MasterPlaylistVideoInfo = {
                ...baseVideoInfo,
                videoRange: 'HDR',
                videoRangeType: 'HDR10',
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                hdr10VideoInfo,
            );

            expect(playlist).toContain('VIDEO-RANGE=PQ');
        });

        it('should include VIDEO-RANGE=HLG for HLG content', () => {
            const hlgVideoInfo: MasterPlaylistVideoInfo = {
                ...baseVideoInfo,
                videoRange: 'HDR',
                videoRangeType: 'HLG',
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                hlgVideoInfo,
            );

            expect(playlist).toContain('VIDEO-RANGE=HLG');
        });

        it('should include VIDEO-RANGE=PQ for Dolby Vision content', () => {
            const doviVideoInfo: MasterPlaylistVideoInfo = {
                ...baseVideoInfo,
                videoRange: 'HDR',
                videoRangeType: 'DOVIWithHDR10',
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                doviVideoInfo,
            );

            expect(playlist).toContain('VIDEO-RANGE=PQ');
        });

        it('should NOT include VIDEO-RANGE for SDR content', () => {
            const sdrVideoInfo: MasterPlaylistVideoInfo = {
                ...baseVideoInfo,
                videoRange: 'SDR',
                videoRangeType: 'SDR',
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                sdrVideoInfo,
            );

            expect(playlist).not.toContain('VIDEO-RANGE');
        });

        it('should NOT include VIDEO-RANGE when videoRange is undefined', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo, // No videoRange/videoRangeType set
            );

            expect(playlist).not.toContain('VIDEO-RANGE');
        });

        it('should prefer videoRangeType over videoRange when both present', () => {
            const mixedVideoInfo: MasterPlaylistVideoInfo = {
                ...baseVideoInfo,
                videoRange: 'HDR', // Generic HDR
                videoRangeType: 'HLG', // Specific HLG
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                mixedVideoInfo,
            );

            // Should use HLG from videoRangeType, not PQ from generic HDR
            expect(playlist).toContain('VIDEO-RANGE=HLG');
        });
    });

    describe('subtitle tracks', () => {
        const subtitleTracks: SubtitleTrackInfo[] = [
            {
                index: 2,
                language: 'ger',
                displayTitle: 'German',
                codec: 'srt',
                isDefault: true,
                isForced: false,
                isTextBased: true,
            },
            {
                index: 3,
                language: 'eng',
                displayTitle: 'English',
                codec: 'srt',
                isDefault: false,
                isForced: false,
                isTextBased: true,
            },
        ];

        it('should include subtitle tracks when provided', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                subtitleTracks,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                undefined,
                'item123',
                'source456',
            );

            expect(playlist).toContain('TYPE=SUBTITLES');
            expect(playlist).toContain('GROUP-ID="subs"');
            expect(playlist).toContain('subs_0/index.m3u8');
            expect(playlist).toContain('subs_1/index.m3u8');
            expect(playlist).toContain('SUBTITLES="subs"');
        });

        it('should mark forced subtitles as DEFAULT=YES', () => {
            const forcedSubtitles: SubtitleTrackInfo[] = [
                {
                    index: 2,
                    language: 'ger',
                    displayTitle: 'German (Forced)',
                    codec: 'srt',
                    isDefault: false,
                    isForced: true,
                    isTextBased: true,
                },
            ];

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                forcedSubtitles,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                undefined,
                'item123',
                'source456',
            );

            expect(playlist).toMatch(/TYPE=SUBTITLES[^#]*DEFAULT=YES[^#]*FORCED=YES/);
        });
    });

    describe('I-frame and trickplay playlists', () => {
        const trickplayInfo: MasterPlaylistTrickplayInfo = {
            width: 320,
            height: 180,
            tileWidth: 10,
            tileHeight: 10,
            thumbnailCount: 100,
            interval: 10000,
            bandwidth: 15000,
        };

        it('should NOT include trickplay playlist by default (opt-in required)', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                undefined,
                'item123',
                'source456',
                trickplayInfo,
                // No options = no trickplay
            );

            // Trickplay is opt-in, not included without explicit request
            expect(playlist).not.toContain('#EXT-X-IMAGE-STREAM-INF');
            expect(playlist).not.toContain('trickplay.m3u8');
        });

        it('should include trickplay playlist when includeTrickplay option is true', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                undefined,
                'item123',
                'source456',
                trickplayInfo,
                { includeTrickplay: true },
            );

            expect(playlist).toContain('#EXT-X-IMAGE-STREAM-INF');
            expect(playlist).toContain('trickplay.m3u8');
            expect(playlist).toContain('CODECS="jpeg"');
            expect(playlist).toContain('RESOLUTION=320x180');
        });

        it('should NOT include I-frame playlist by default (opt-in required)', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                undefined,
                'item123',
                'source456',
                trickplayInfo,
                // No options = no I-frames
            );

            // I-frames are opt-in, not included without explicit request
            expect(playlist).not.toContain('#EXT-X-I-FRAME-STREAM-INF');
            expect(playlist).not.toContain('iframe.m3u8');
        });

        it('should include synthetic I-frame playlist when syntheticIframes option is true', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                'hevc',
                'item123',
                'source456',
                trickplayInfo,
                { syntheticIframes: true },
            );

            expect(playlist).toContain('#EXT-X-I-FRAME-STREAM-INF');
            expect(playlist).toContain('iframe.m3u8');
            expect(playlist).toContain('synthetic=true');
            expect(playlist).toContain('RESOLUTION=320x180');
            // Synthetic I-frames always use H.264 baseline (regardless of source codec).
            // Constraint byte C0 (set0+set1) is what libx264 actually emits — verified
            // against a real segment's SPS (67 42 c0 1e). Declaring E0 here made
            // AVPlayer accept the variant and then render nothing.
            expect(playlist).toContain('CODECS="avc1.42C01E"');
        });

        it('should include both trickplay and I-frames when both options are true', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                'hevc',
                'item123',
                'source456',
                trickplayInfo,
                { includeTrickplay: true, syntheticIframes: true },
            );

            expect(playlist).toContain('#EXT-X-IMAGE-STREAM-INF');
            expect(playlist).toContain('trickplay.m3u8');
            expect(playlist).toContain('#EXT-X-I-FRAME-STREAM-INF');
            expect(playlist).toContain('iframe.m3u8');
        });

        it('should NOT include trickplay without trickplayInfo even with option set', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                undefined,
                'item123',
                'source456',
                undefined, // No trickplayInfo
                { includeTrickplay: true, syntheticIframes: true },
            );

            // No trickplay info means no trickplay streams even with options
            expect(playlist).not.toContain('#EXT-X-IMAGE-STREAM-INF');
            expect(playlist).not.toContain('#EXT-X-I-FRAME-STREAM-INF');
        });
    });

    describe('isNativeHlsClient', () => {
        // Decides both the native master playlist and source-absolute tfdt on
        // seeked copy generations (subtitle timing in the Apple apps).
        it('recognises the Apple apps by device profile or Apple TV user agent', () => {
            expect(isNativeHlsClient({ deviceProfileId: 'apple-tv' })).toBe(true);
            expect(isNativeHlsClient({ userAgent: 'Lumastra/1.0.1 tvOS/26.1' })).toBe(true);
            expect(isNativeHlsClient({ userAgent: 'AppleTV11,1/26.1' })).toBe(true);
        });

        it('leaves browsers and unknown clients out', () => {
            expect(isNativeHlsClient({})).toBe(false);
            expect(isNativeHlsClient({ deviceProfileId: 'chrome' })).toBe(false);
            expect(
                isNativeHlsClient({
                    userAgent:
                        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
                }),
            ).toBe(false);
        });

        it('keeps iPhone/iPad web out: it renders <track> against currentTime, so it needs no source-absolute tfdt', () => {
            expect(
                isNativeHlsClient({
                    userAgent:
                        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
                }),
            ).toBe(false);
            expect(
                isNativeHlsClient({
                    deviceProfileId: 'safari-ios',
                    userAgent:
                        'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
                }),
            ).toBe(false);
        });
    });

    describe('resolveSyntheticIframes', () => {
        // AVPlayer draws its scrubbing thumbnails ONLY from an I-frame variant in
        // the master playlist. The tvOS client has no trickplay code of its own and
        // never sends iframes=synthetic, so requiring the opt-in meant Apple TV
        // never got scrubbing previews. Auto-enable it for native-HLS clients.

        it('auto-enables for the apple-tv device profile without any query param', () => {
            expect(resolveSyntheticIframes({ deviceProfileId: 'apple-tv' })).toBe(true);
        });

        it('still honours an explicit iframes=synthetic opt-in from any client', () => {
            expect(
                resolveSyntheticIframes({ deviceProfileId: 'chrome', iframesParam: 'synthetic' }),
            ).toBe(true);
        });

        it('stays off for browsers that neither opt in nor need it', () => {
            expect(resolveSyntheticIframes({ deviceProfileId: 'chrome' })).toBe(false);
            expect(resolveSyntheticIframes({})).toBe(false);
        });

        it('ignores an unrecognised iframes value', () => {
            expect(
                resolveSyntheticIframes({ deviceProfileId: 'chrome', iframesParam: 'yes' }),
            ).toBe(false);
        });

        it('recognises a tvOS user agent when no device profile is resolved', () => {
            expect(
                resolveSyntheticIframes({ userAgent: 'Lumastra/1.0 (Apple TV; tvOS 17.4)' }),
            ).toBe(true);
        });
    });

    describe('codec strings', () => {
        it('should use HEVC codec string for hevc video', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo, // codec: 'hevc'
                'hevc',
            );

            expect(playlist).toMatch(/CODECS="hvc1\.[^"]+,mp4a\.40\.2"/);
        });

        it('should use H.264 codec string for h264 video', () => {
            const h264VideoInfo: MasterPlaylistVideoInfo = {
                codec: 'h264',
                width: 1920,
                height: 1080,
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                h264VideoInfo,
                'h264',
            );

            expect(playlist).toMatch(/CODECS="avc1\.[^"]+,mp4a\.40\.2"/);
        });

        // --- container-aware signaling + level policy (sibling-bug regressions) ---

        it('signals hev1 (not hvc1) for HEVC when segments are MPEG-TS', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                'hevc',
                undefined,
                undefined,
                undefined,
                { hlsContainer: 'mpegts' },
            );

            expect(playlist).toContain('hev1.');
            expect(playlist).not.toContain('hvc1.');
        });

        it('signals hvc1 for HEVC in fMP4 (default container)', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                'hevc',
            );

            expect(playlist).toContain('hvc1.');
            expect(playlist).not.toContain('hev1.');
        });

        it('declares L153 (not L120) for a sub-4K HEVC transcode', () => {
            const transcoded1080p: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                isTranscoded: true,
            };
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                20000000,
                transcoded1080p,
                'hevc',
            );

            // Encoder emits Level 5.1; manifest must not under-declare to L120.
            expect(playlist).toMatch(/hvc1\.1\.6\.L153/);
            expect(playlist).not.toContain('L120');
        });

        it('declares the SOURCE level (not hardcoded L153) for an HEVC stream copy', () => {
            // Video is copied (isTranscoded falsey), source is Level 4.0 (L120).
            // Over-declaring L153 makes strict decoders (Firefox/Linux VA-API)
            // reject the CODECS string via isTypeSupported and stall, while the
            // actual copied bitstream is only L120.
            const copiedL120: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                level: 120,
            };
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                20000000,
                copiedL120,
                'hevc',
            );

            expect(playlist).toMatch(/hvc1\.1\.6\.L120\.B0/);
            expect(playlist).not.toContain('L153');
        });

        it('falls back to L153 for an HEVC copy when the source level is unknown', () => {
            // No level on the source → keep the Safari-safe over-declaration so a
            // too-LOW level never makes AVPlayer silently reject the stream.
            const copiedNoLevel: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
            };
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                20000000,
                copiedNoLevel,
                'hevc',
            );

            expect(playlist).toMatch(/hvc1\.1\.6\.L153\.B0/);
        });

        it('declares Main 10 for a software (libx265) SDR HEVC transcode', () => {
            const swTranscode: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                isTranscoded: true,
                outputHevcMain10: true,
            };
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                20000000,
                swTranscode,
                'hevc',
            );

            expect(playlist).toMatch(/hvc1\.2\.4\.L153/);
        });

        // Profiles 5/7 have no base layer, so the DV codec is the PRIMARY entry and
        // the muxer tags the sample entry to match (dvh1 fMP4 / dvhe TS).
        it('uses dvhe / dvh1 prefix per container for non-cross-compatible DV (profile 5)', () => {
            const dv5: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 3840,
                height: 2160,
                videoRangeType: 'DOVI',
                dvProfile: 5,
            };
            const fmp4 = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                50000000,
                dv5,
                'hevc',
            );
            const ts = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                50000000,
                dv5,
                'hevc',
                undefined,
                undefined,
                undefined,
                { hlsContainer: 'mpegts' },
            );

            expect(fmp4).toContain('dvh1.05.');
            expect(ts).toContain('dvhe.05.');
        });

        it('uses dvhe in SUPPLEMENTAL-CODECS for DV8 over MPEG-TS', () => {
            const dv8: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 3840,
                height: 2160,
                videoRangeType: 'DOVI',
                dvProfile: 8,
            };
            const ts = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                50000000,
                dv8,
                'hevc',
                undefined,
                undefined,
                undefined,
                { hlsContainer: 'mpegts' },
            );

            expect(ts).toContain('hev1.2.4.L153');
            expect(ts).toContain('SUPPLEMENTAL-CODECS="dvhe.08.');
        });

        // Regression: "Wake Up Dead Man" (DV P8.1 in MKV, HEVC Level 4.0, Main 10)
        // remuxed to HLS played audio over a black screen on Apple TV. The manifest
        // advertised DV that the fMP4 did not carry, and the probe leaves
        // video_range_type NULL on this file, so the HDR signalling had to come from
        // the DV configuration record instead.
        it('signals a DV P8.1 MKV remux as HDR10 Main 10 even when videoRangeType is absent', () => {
            const dv81: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                dvProfile: 8,
                dvLevel: 3,
                dvBlSignalCompatibilityId: 1,
                level: 120,
                profile: 'Main 10',
                isTranscoded: false,
                // videoRangeType intentionally omitted — NULL in prod for this file.
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                50000000,
                dv81,
                'hevc',
            );

            // CODECS must describe the HDR10 base layer with an `hvc1` prefix, because
            // that is the sample-entry 4CC the muxer writes for cross-compatible DV.
            // The old `dvh1` tag contradicted this and broke AVPlayer.
            //
            // Level must be the source's real one (120 = 4.0), not the hardcoded L153
            // this branch used to emit — L153 claimed 5.1 for a 4.0 bitstream and
            // contradicted the DV level 03 in our own SUPPLEMENTAL-CODECS.
            expect(playlist).toContain('hvc1.2.4.L120.B0');
            expect(playlist).not.toContain('L153');
            // HDR must survive — derived from the DV record, not videoRangeType.
            expect(playlist).toContain('VIDEO-RANGE=PQ');
            // DV advertised out of band, with the 8.1 HDR10-base compatibility brand.
            expect(playlist).toContain('SUPPLEMENTAL-CODECS="dvh1.08.03/db1p"');
        });

        it('declares AV1 Level 4.1 (09) for 1080p (not 4.0)', () => {
            const av1_1080p: MasterPlaylistVideoInfo = {
                codec: 'av1',
                width: 1920,
                height: 1080,
            };
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                12000000,
                av1_1080p,
                'av1',
            );

            expect(playlist).toContain('av01.0.09M.08');
        });

        it('declares H.264 Level 4.2 (0x2a) for 1080p (not 4.0)', () => {
            const h264_1080p: MasterPlaylistVideoInfo = {
                codec: 'h264',
                width: 1920,
                height: 1080,
            };
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                15000000,
                h264_1080p,
                'h264',
            );

            expect(playlist).toContain('avc1.64002a');
        });

        it('declares the ACTUAL forced level for an H.264 transcode (4.0 for 1080p), not a safe-high one', () => {
            const h264Transcode1080p: MasterPlaylistVideoInfo = {
                codec: 'h264',
                width: 1920,
                height: 1080,
                isTranscoded: true,
            };
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                15000000,
                h264Transcode1080p,
                'h264',
            );

            // Encoder forces Level 4.0 for <=2048-wide; manifest must not over-declare 4.2.
            expect(playlist).toContain('avc1.640028');
            expect(playlist).not.toContain('avc1.64002a');
        });

        it('declares 10-bit for a 10-bit SDR AV1 source (not 8-bit)', () => {
            const av1_10bitSdr: MasterPlaylistVideoInfo = {
                codec: 'av1',
                width: 1920,
                height: 1080,
                videoRangeType: 'SDR',
                bitDepth: 10,
            };
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                12000000,
                av1_10bitSdr,
                'av1',
            );

            expect(playlist).toContain('av01.0.09M.10');
        });

        it('buckets portrait AV1 by its larger dimension (1080x1920 → Level 4.1)', () => {
            const portraitAv1: MasterPlaylistVideoInfo = {
                codec: 'av1',
                width: 1080,
                height: 1920,
            };
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                12000000,
                portraitAv1,
                'av1',
            );

            // width alone (1080) would under-declare Level 4.0; max dim (1920) → 4.1.
            expect(playlist).toContain('av01.0.09M.08');
        });

        it('should use 4K SDR codec profile for 4K resolution without HDR', () => {
            const video4K: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 3840,
                height: 2160,
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                50000000,
                video4K,
                'hevc',
            );

            // 4K SDR HEVC: Main profile (1.6), Level 5.1 (L153)
            expect(playlist).toMatch(/hvc1\.1\.6\.L153/);
        });

        it('should use Main 10 profile for 1080p HDR10 content (regression)', () => {
            const hdr1080p: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                videoRange: 'HDR10',
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                40000000,
                hdr1080p,
                'hevc',
            );

            // 1080p HDR10 HEVC: Main 10 profile (2.4), Level 5.1 (L153)
            // Regression: previously used hev1.1.6.L120 (Main, Level 4.0)
            // which caused Safari to silently reject the stream.
            expect(playlist).toMatch(/hvc1\.2\.4\.L153/);
        });

        it('describes DOVI Profile 8 base layer in CODECS with DV in SUPPLEMENTAL-CODECS', () => {
            const doviVideoInfo: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 3840,
                height: 2160,
                videoRangeType: 'DOVI',
                dvProfile: 8, // Explicit DV Profile 8 for SUPPLEMENTAL-CODECS
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                50000000,
                doviVideoInfo,
                'hevc',
            );

            // CODECS describes the HDR10 base layer (the non-DV fallback); DV is
            // advertised out of band, backed by the dvvC box in the init segment.
            expect(playlist).toContain('hvc1.2.4.L153');
            expect(playlist).toContain('VIDEO-RANGE=PQ');
            expect(playlist).toContain('SUPPLEMENTAL-CODECS="dvh1.08.06"');
        });

        it('describes DOVIWithHDR10 base layer in CODECS with DV in SUPPLEMENTAL-CODECS', () => {
            const doviHdr10VideoInfo: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 3840,
                height: 2160,
                videoRangeType: 'DOVIWithHDR10',
                dvProfile: 8, // Explicit DV Profile 8 for SUPPLEMENTAL-CODECS
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                50000000,
                doviHdr10VideoInfo,
                'hevc',
            );

            expect(playlist).toContain('hvc1.2.4.L153');
            expect(playlist).toContain('VIDEO-RANGE=PQ');
            expect(playlist).toContain('SUPPLEMENTAL-CODECS="dvh1.08.06"');
        });

        it('should use HEVC codec string for HDR10 (non-Dolby) content', () => {
            const hdr10VideoInfo: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 3840,
                height: 2160,
                videoRangeType: 'HDR10',
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                50000000,
                hdr10VideoInfo,
                'hevc',
            );

            // Regular HEVC for HDR10 (not Dolby Vision) - hvc1 per Apple HLS spec
            expect(playlist).toContain('hvc1.2.4.L153');
            expect(playlist).not.toContain('dvh1');
        });

        describe('transcoded content (HDR→SDR tone mapping)', () => {
            it('should use HEVC Main profile (not Main 10) when transcoding', () => {
                const transcodedVideoInfo: MasterPlaylistVideoInfo = {
                    codec: 'av1', // Source is AV1
                    width: 3840,
                    height: 1606,
                    videoRangeType: 'HDR10',
                    isTranscoded: true, // Jellyfin transcodes AV1→HEVC, tone-maps HDR→SDR
                };

                const playlist = generateMasterPlaylist(
                    baseAudioTracks,
                    undefined,
                    '/segment',
                    new URLSearchParams(),
                    50000000,
                    transcodedVideoInfo,
                    'hevc', // Output codec
                );

                // Transcoded HEVC uses Main profile (hvc1.1.6) not Main 10 (hvc1.2.4)
                // because Jellyfin tone-maps HDR to SDR, outputting 8-bit HEVC
                expect(playlist).toContain('hvc1.1.6.L153');
                expect(playlist).not.toContain('hvc1.2.4');
            });

            it('should NOT include VIDEO-RANGE when transcoding HDR content', () => {
                const transcodedHdrVideoInfo: MasterPlaylistVideoInfo = {
                    codec: 'av1',
                    width: 3840,
                    height: 1606,
                    videoRange: 'HDR',
                    videoRangeType: 'HDR10',
                    isTranscoded: true, // Jellyfin transcodes and tone-maps to SDR
                };

                const playlist = generateMasterPlaylist(
                    baseAudioTracks,
                    undefined,
                    '/segment',
                    new URLSearchParams(),
                    50000000,
                    transcodedHdrVideoInfo,
                    'hevc',
                );

                // VIDEO-RANGE should NOT be present because transcoded content is SDR
                expect(playlist).not.toContain('VIDEO-RANGE');
            });

            it('should use Main 10 profile when NOT transcoding HDR content', () => {
                const directStreamHdrVideoInfo: MasterPlaylistVideoInfo = {
                    codec: 'hevc',
                    width: 3840,
                    height: 1606,
                    videoRangeType: 'HDR10',
                    isTranscoded: false, // Direct stream, no transcoding
                };

                const playlist = generateMasterPlaylist(
                    baseAudioTracks,
                    undefined,
                    '/segment',
                    new URLSearchParams(),
                    50000000,
                    directStreamHdrVideoInfo,
                    'hevc',
                );

                // Direct stream preserves HDR, uses Main 10 profile
                expect(playlist).toContain('hvc1.2.4.L153');
                expect(playlist).toContain('VIDEO-RANGE=PQ');
            });
        });
    });

    describe('HDR-preserved transcodes (full mode)', () => {
        it('should use Main 10 profile for HDR-preserved HEVC transcode', () => {
            const hdrPreservedVideoInfo: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 3840,
                height: 2160,
                videoRangeType: 'HDR10',
                isTranscoded: true,
                preserveHdr: true,
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                50000000,
                hdrPreservedVideoInfo,
                'hevc',
            );

            // HDR-preserved transcode must use Main 10 profile
            expect(playlist).toContain('hvc1.2.4.L153');
            expect(playlist).toContain('VIDEO-RANGE=PQ');
        });

        it('should use VIDEO-RANGE=HLG for HLG-preserved transcode', () => {
            const hlgPreservedVideoInfo: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                videoRangeType: 'HLG',
                isTranscoded: true,
                preserveHdr: true,
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                hlgPreservedVideoInfo,
                'hevc',
            );

            expect(playlist).toContain('hvc1.2.4');
            expect(playlist).toContain('VIDEO-RANGE=HLG');
        });

        it('should use Main profile when transcoding SDR (preserveHdr=false)', () => {
            const sdrTranscodeVideoInfo: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                videoRangeType: 'SDR',
                isTranscoded: true,
                preserveHdr: false,
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                sdrTranscodeVideoInfo,
                'hevc',
            );

            // SDR transcoded HEVC: Main profile (8-bit)
            expect(playlist).toContain('hvc1.1.6');
            expect(playlist).not.toContain('VIDEO-RANGE');
        });
    });

    describe('10-bit SDR content (regression)', () => {
        it('should use Main 10 profile for 10-bit SDR HEVC (bitDepth=10)', () => {
            const sdr10bitVideoInfo: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                videoRangeType: 'SDR',
                bitDepth: 10,
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                sdr10bitVideoInfo,
                'hevc',
            );

            // 10-bit SDR needs Main 10 profile — HEVC profile is about
            // bit depth, not color space
            expect(playlist).toContain('hvc1.2.4.L153');
            // But should NOT include VIDEO-RANGE (it's SDR)
            expect(playlist).not.toContain('VIDEO-RANGE');
        });

        it('should use Main 10 profile for "Main 10" profile string', () => {
            const main10ProfileVideoInfo: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                videoRangeType: 'SDR',
                profile: 'Main 10',
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                main10ProfileVideoInfo,
                'hevc',
            );

            expect(playlist).toContain('hvc1.2.4.L153');
            expect(playlist).not.toContain('VIDEO-RANGE');
        });

        it('should use Main profile for 8-bit SDR HEVC', () => {
            const sdr8bitVideoInfo: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                videoRangeType: 'SDR',
                bitDepth: 8,
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                sdr8bitVideoInfo,
                'hevc',
            );

            // 8-bit SDR: Main profile
            expect(playlist).toContain('hvc1.1.6.L153');
        });
    });

    describe('SDR HEVC regression (tvOS -12927 bug)', () => {
        // Core regression: SDR HEVC content must NEVER get HDR CODECS
        // or VIDEO-RANGE attributes, regardless of how it's delivered.

        it('SDR HEVC direct stream: Main profile, no VIDEO-RANGE', () => {
            const sdrHevcDirect: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                videoRange: undefined,
                videoRangeType: 'SDR',
                isTranscoded: false,
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                sdrHevcDirect,
                'hevc',
            );

            expect(playlist).toContain('hvc1.1.6.L153');
            expect(playlist).not.toContain('hvc1.2.4');
            expect(playlist).not.toContain('VIDEO-RANGE');
        });

        it('SDR HEVC transcode: Main profile, no VIDEO-RANGE', () => {
            const sdrHevcTranscode: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                videoRangeType: 'SDR',
                isTranscoded: true,
                preserveHdr: false,
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                sdrHevcTranscode,
                'hevc',
            );

            expect(playlist).toContain('hvc1.1.6');
            expect(playlist).not.toContain('hvc1.2.4');
            expect(playlist).not.toContain('VIDEO-RANGE');
        });

        it('SDR HEVC with preserveHdr=true but SDR rangeType: treats as SDR transcode', () => {
            // Defensive test: even if preserveHdr leaks through for SDR,
            // classifyHdrSource returns isHdr=false so Main profile is used
            const sdrButPreserveFlag: MasterPlaylistVideoInfo = {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                videoRangeType: 'SDR',
                isTranscoded: true,
                preserveHdr: true, // Bug scenario: this flag shouldn't be true for SDR
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                sdrButPreserveFlag,
                'hevc',
            );

            // classifyHdrSource('SDR') returns isHdr=false, so preserveHdr is ignored
            expect(playlist).toContain('hvc1.1.6');
            expect(playlist).not.toContain('hvc1.2.4');
        });
    });

    describe('Apple HLS spec MUST attributes', () => {
        it('should include AVERAGE-BANDWIDTH (spec 9.14)', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                'hevc',
            );

            expect(playlist).toContain('AVERAGE-BANDWIDTH=20000000');
        });

        it('should include FRAME-RATE even when not provided (spec 9.15)', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo, // no frameRate
                'hevc',
            );

            // Defaults to 23.976 when not provided
            expect(playlist).toContain('FRAME-RATE=23.976');
        });

        it('should use actual FRAME-RATE when provided', () => {
            const videoWithFps: MasterPlaylistVideoInfo = {
                ...baseVideoInfo,
                frameRate: 24,
            };

            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                videoWithFps,
                'hevc',
            );

            expect(playlist).toContain('FRAME-RATE=24');
        });
    });

    describe('audio codec strings', () => {
        it('should use AAC codec string by default (no audio options)', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                'hevc',
            );

            // Default is AAC-LC when no audio options provided
            expect(playlist).toContain('mp4a.40.2');
        });

        it('should use AAC codec string when audio is transcoded', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                'hevc',
                undefined,
                undefined,
                undefined,
                { audioCodec: 'aac', isAudioCopied: false },
            );

            expect(playlist).toContain('mp4a.40.2');
        });

        it('should use source audio codec when audio is copied (E-AC-3)', () => {
            const eac3AudioTracks: AudioTrackInfo[] = [
                {
                    index: asAbsoluteStreamIndex(0),
                    language: 'eng',
                    displayTitle: 'English Atmos',
                    channels: 8,
                    codec: 'eac3',
                    isDefault: true,
                },
            ];

            const playlist = generateMasterPlaylist(
                eac3AudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                'hevc',
                undefined,
                undefined,
                undefined,
                { audioCodec: 'eac3', isAudioCopied: true },
            );

            // E-AC-3 (Dolby Digital Plus / Atmos) uses 'ec-3' codec string
            expect(playlist).toContain('ec-3');
            expect(playlist).not.toContain('mp4a.40.2');
        });

        it('names every copied rendition codec, the selected one first', () => {
            const mixed: AudioTrackInfo[] = [
                {
                    index: asAbsoluteStreamIndex(1),
                    language: 'eng',
                    displayTitle: 'English 5.1',
                    channels: 6,
                    codec: 'ac3',
                    isDefault: true,
                },
                {
                    index: asAbsoluteStreamIndex(2),
                    language: 'ger',
                    displayTitle: 'German Stereo',
                    channels: 2,
                    codec: 'aac',
                    isDefault: false,
                },
                {
                    index: asAbsoluteStreamIndex(3),
                    language: 'fre',
                    displayTitle: 'French 5.1',
                    channels: 6,
                    codec: 'ac3',
                    isDefault: false,
                },
            ];

            const playlist = generateMasterPlaylist(
                mixed,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                { codec: 'h264', width: 1920, height: 1080, bitrate: 8000000 },
                'h264',
                undefined,
                undefined,
                undefined,
                { audioCodec: 'aac', isAudioCopied: true },
            );

            expect(playlist).toMatch(/CODECS="avc1\.[0-9a-f]+,mp4a\.40\.2,ac-3"/);
        });

        it('lists a track the server re-encodes (DTS) as AAC, not as its source codec', () => {
            const playlist = generateMasterPlaylist(
                [
                    {
                        index: asAbsoluteStreamIndex(1),
                        language: 'eng',
                        displayTitle: 'English 5.1',
                        channels: 6,
                        codec: 'eac3',
                        isDefault: true,
                    },
                    {
                        index: asAbsoluteStreamIndex(2),
                        language: 'eng',
                        displayTitle: 'English DTS',
                        channels: 6,
                        codec: 'dts',
                        isDefault: false,
                    },
                ],
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                { codec: 'h264', width: 1920, height: 1080, bitrate: 8000000 },
                'h264',
                undefined,
                undefined,
                undefined,
                { audioCodec: 'eac3', isAudioCopied: true },
            );

            expect(playlist).toMatch(/CODECS="avc1\.[0-9a-f]+,ec-3,mp4a\.40\.2"/);
            expect(playlist).not.toMatch(/CODECS="[^"]*dts/i);
        });

        it('should use source audio codec when audio is copied (AC-3)', () => {
            const ac3AudioTracks: AudioTrackInfo[] = [
                {
                    index: asAbsoluteStreamIndex(0),
                    language: 'eng',
                    displayTitle: 'English 5.1',
                    channels: 6,
                    codec: 'ac3',
                    isDefault: true,
                },
            ];

            const playlist = generateMasterPlaylist(
                ac3AudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                'hevc',
                undefined,
                undefined,
                undefined,
                { audioCodec: 'ac3', isAudioCopied: true },
            );

            // AC-3 (Dolby Digital) uses 'ac-3' codec string
            expect(playlist).toContain('ac-3');
            expect(playlist).not.toContain('mp4a.40.2');
        });

        it('should use FLAC codec string when audio is copied (FLAC)', () => {
            const flacAudioTracks: AudioTrackInfo[] = [
                {
                    index: asAbsoluteStreamIndex(0),
                    language: 'eng',
                    displayTitle: 'English Lossless',
                    channels: 2,
                    codec: 'flac',
                    isDefault: true,
                },
            ];

            const playlist = generateMasterPlaylist(
                flacAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                'hevc',
                undefined,
                undefined,
                undefined,
                { audioCodec: 'flac', isAudioCopied: true },
            );

            // FLAC uses 'fLaC' codec string
            expect(playlist).toContain('fLaC');
        });

        it('should fallback to AAC for non-HLS-compatible codecs (TrueHD)', () => {
            const playlist = generateMasterPlaylist(
                baseAudioTracks,
                undefined,
                '/segment',
                new URLSearchParams(),
                25000000,
                baseVideoInfo,
                'hevc',
                undefined,
                undefined,
                undefined,
                { audioCodec: 'truehd', isAudioCopied: true },
            );

            // TrueHD is not HLS-compatible, should fallback to AAC
            expect(playlist).toContain('mp4a.40.2');
        });
    });
});

describe('calculateEstimatedBandwidth', () => {
    it('should use minimum bandwidth floor for 1080p even with lower bitrate', () => {
        const videoInfo = { width: 1920, height: 1080, bitrate: 20000000 };
        const audioTracks: AudioTrackInfo[] = [
            {
                index: asAbsoluteStreamIndex(0),
                language: 'eng',
                displayTitle: 'English',
                channels: 2,
                codec: 'aac',
                isDefault: true,
            },
        ];

        const bandwidth = calculateEstimatedBandwidth(videoInfo, audioTracks);

        // 1080p has a 40Mbps minimum floor to avoid AVPlayer -12318 errors
        // Even though calculated is ~23M, it floors to 40M
        expect(bandwidth).toBe(40_000_000);
    });

    it('should use minimum bandwidth floor regardless of audio channels', () => {
        const videoInfo = { width: 1920, height: 1080, bitrate: 20000000 };
        const audioTracks: AudioTrackInfo[] = [
            {
                index: asAbsoluteStreamIndex(0),
                language: 'eng',
                displayTitle: 'English 5.1',
                channels: 6,
                codec: 'aac',
                isDefault: true,
            },
        ];

        const bandwidth = calculateEstimatedBandwidth(videoInfo, audioTracks);

        // 1080p minimum floor of 40Mbps applies
        expect(bandwidth).toBe(40_000_000);
    });

    it('should estimate bandwidth from resolution when bitrate unknown', () => {
        const videoInfo = { width: 3840, height: 2160 }; // 4K, no bitrate

        const bandwidth = calculateEstimatedBandwidth(videoInfo);

        // 4K defaults to ~50Mbps + audio + overhead
        expect(bandwidth).toBeGreaterThan(50000000);
    });

    it('should use lower estimate for 1080p without bitrate', () => {
        const videoInfo = { width: 1920, height: 1080 }; // 1080p, no bitrate

        const bandwidth = calculateEstimatedBandwidth(videoInfo);

        // 1080p defaults to ~20Mbps
        expect(bandwidth).toBeGreaterThan(20000000);
        expect(bandwidth).toBeLessThan(50000000);
    });

    it('should handle missing video info', () => {
        const bandwidth = calculateEstimatedBandwidth();

        // Should default to some reasonable estimate
        expect(bandwidth).toBeGreaterThan(0);
    });
});

describe('HEVC level declaration in CODECS', () => {
    const levelAudioTracks: AudioTrackInfo[] = [
        {
            index: asAbsoluteStreamIndex(0),
            language: 'eng',
            displayTitle: 'English 5.1',
            channels: 6,
            codec: 'aac',
            isDefault: true,
        },
    ];
    const base = (level?: number): MasterPlaylistVideoInfo => ({
        codec: 'hevc',
        width: 1920,
        height: 1080,
        profile: 'Main 10',
        level,
        isTranscoded: false,
    });
    const build = (videoInfo: MasterPlaylistVideoInfo) =>
        generateMasterPlaylist(
            levelAudioTracks,
            undefined,
            '/segment',
            new URLSearchParams(),
            50000000,
            videoInfo,
            'hevc',
        );

    it('declares the source level for a plain HEVC copy', () => {
        expect(build(base(120))).toContain('hvc1.2.4.L120.B0');
    });

    // ffprobe reports -99 for an unknown level and ffprobe.ts stores numbers
    // verbatim, so a plain `?? 153` let it through and emitted `L-99`.
    it("falls back to L153 for ffprobe's -99 unknown-level sentinel", () => {
        const playlist = build(base(-99));
        expect(playlist).toContain('hvc1.2.4.L153.B0');
        expect(playlist).not.toContain('L-99');
    });

    it('falls back to L153 when level is absent or zero', () => {
        expect(build(base(undefined))).toContain('L153');
        expect(build(base(0))).toContain('L153');
    });
});

describe('generateMuxedMasterPlaylist', () => {
    const uri = '/api/playback/x/hls?PlaySessionId=abc&hlsPlaylist=media';

    // tvOS sets the display's HDR mode from the manifest before parsing any media,
    // so an HDR10 muxed rendition served as a bare media playlist decoded fine but
    // left the TV in SDR with no HDR indicator. The master exists to carry
    // VIDEO-RANGE (and CODECS, which Apple's authoring spec requires).
    it('declares VIDEO-RANGE=PQ and CODECS for an HDR10 muxed rendition', () => {
        const playlist = generateMuxedMasterPlaylist(
            uri,
            40000000,
            {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                level: 120,
                profile: 'Main 10',
                videoRangeType: 'HDR10',
                frameRate: 24,
                isTranscoded: false,
            },
            'hevc',
            { audioCodec: 'eac3', isAudioCopied: true },
        );

        expect(playlist).toContain('#EXT-X-STREAM-INF:');
        expect(playlist).toContain('VIDEO-RANGE=PQ');
        expect(playlist).toContain('hvc1.2.4.L120.B0');
        expect(playlist).toContain('ec-3');
        expect(playlist).toContain('RESOLUTION=1920x1080');
        expect(playlist).toContain(uri);
    });

    // Audio is inside the same segments, so there is exactly one rendition — no
    // EXT-X-MEDIA group and no AUDIO= attribute (unlike the demux master).
    it('emits a single variant with no audio rendition group', () => {
        const playlist = generateMuxedMasterPlaylist(uri, 40000000, {
            codec: 'hevc',
            width: 1920,
            height: 1080,
        });

        expect(playlist).not.toContain('#EXT-X-MEDIA:');
        expect(playlist).not.toContain('AUDIO="audio"');
        expect(playlist.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(1);
    });

    it('carries SUPPLEMENTAL-CODECS for cross-compatible Dolby Vision', () => {
        const playlist = generateMuxedMasterPlaylist(
            uri,
            40000000,
            {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                level: 120,
                dvProfile: 8,
                dvLevel: 3,
                dvBlSignalCompatibilityId: 1,
                isTranscoded: false,
            },
            'hevc',
        );

        expect(playlist).toContain('SUPPLEMENTAL-CODECS="dvh1.08.03/db1p"');
        expect(playlist).toContain('VIDEO-RANGE=PQ');
    });

    // AVPlayer still reaches the muxed master for transcoded content (a tvOS
    // client playing AV1 lands on delivery_path mse_hls), so the scrubbing
    // variant has to be offered here too, not only on the demux master.
    describe('synthetic I-frames', () => {
        const trickplayInfo: MasterPlaylistTrickplayInfo = {
            width: 320,
            height: 180,
            tileWidth: 10,
            tileHeight: 10,
            thumbnailCount: 240,
            interval: 10000,
            bandwidth: 100000,
        };

        it('includes the I-frame variant when requested', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                { codec: 'hevc', width: 1920, height: 1080 },
                'hevc',
                { syntheticIframes: true },
                { segmentBase: '/segment', trickplayInfo, itemId: 'item123', fileId: 'source456' },
            );

            expect(playlist).toContain('#EXT-X-I-FRAME-STREAM-INF');
            expect(playlist).toContain('iframe.m3u8');
            expect(playlist).toContain('synthetic=true');
            expect(playlist).toContain('CODECS="avc1.42C01E"');
        });

        it('omits the I-frame variant when the title has no trickplay data', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                { codec: 'hevc', width: 1920, height: 1080 },
                'hevc',
                { syntheticIframes: true },
                { segmentBase: '/segment', itemId: 'item123' },
            );

            expect(playlist).not.toContain('#EXT-X-I-FRAME-STREAM-INF');
        });

        it('omits the I-frame variant when not requested', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                { codec: 'hevc', width: 1920, height: 1080 },
                'hevc',
                {},
                { segmentBase: '/segment', trickplayInfo, itemId: 'item123' },
            );

            expect(playlist).not.toContain('#EXT-X-I-FRAME-STREAM-INF');
        });

        it('still emits exactly one EXT-X-STREAM-INF variant', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                { codec: 'hevc', width: 1920, height: 1080 },
                'hevc',
                { syntheticIframes: true },
                { segmentBase: '/segment', trickplayInfo, itemId: 'item123' },
            );

            // I-frame variants are a separate tag; the muxed rendition stays single.
            const streamInfCount = playlist
                .split('\n')
                .filter((l) => l.startsWith('#EXT-X-STREAM-INF')).length;
            expect(streamInfCount).toBe(1);
        });
    });

    // Regression: this generator was added so tvOS could read VIDEO-RANGE before
    // configuring the display's HDR mode, and routing native-HLS clients through it
    // dropped EXT-X-MEDIA:TYPE=SUBTITLES entirely. Effect on prod: an Apple TV
    // playing direct/remux content (demux master) offered every subtitle track,
    // while the same Apple TV playing anything transcoded (mse_hls → muxed) offered
    // none. "Muxed" only means audio shares the video's segments — subtitles are a
    // separate MEDIA group on both masters.
    describe('subtitle renditions', () => {
        const subs: SubtitleTrackInfo[] = [
            {
                index: 2,
                displayTitle: 'English',
                language: 'eng',
                codec: 'subrip',
                isDefault: true,
                isForced: false,
                isTextBased: true,
            },
            {
                index: 3,
                displayTitle: 'German Forced',
                language: 'ger',
                codec: 'ass',
                isDefault: false,
                isForced: true,
                isTextBased: true,
            },
        ];

        const videoInfo = { codec: 'hevc', width: 1920, height: 1080 };

        it('emits one EXT-X-MEDIA per text subtitle track', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                videoInfo,
                'hevc',
                {},
                {
                    segmentBase: '/segment',
                    params: new URLSearchParams({ PlaySessionId: 'abc' }),
                    itemId: 'item123',
                    fileId: 'source456',
                    subtitleTracks: subs,
                },
            );

            const mediaLines = playlist
                .split('\n')
                .filter((l) => l.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'));
            expect(mediaLines).toHaveLength(2);
            expect(mediaLines[0]).toContain('LANGUAGE="eng"');
            expect(mediaLines[0]).toContain('subs_0/index.m3u8');
            expect(mediaLines[1]).toContain('LANGUAGE="ger"');
            expect(mediaLines[1]).toContain('subs_1/index.m3u8');
        });

        // Each rendition must address its OWN track, or every entry in the group
        // resolves to the same subtitle and native switching silently no-ops.
        it('points each rendition at its own absolute stream index', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                videoInfo,
                'hevc',
                {},
                {
                    segmentBase: '/segment',
                    itemId: 'item123',
                    fileId: 'source456',
                    subtitleTracks: subs,
                },
            );

            expect(playlist).toContain('SubtitleIndex=2');
            expect(playlist).toContain('SubtitleIndex=3');
        });

        // The path endpoint 400s without fileId, so the group has to reference it.
        it('threads fileId onto every subtitle playlist URL', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                videoInfo,
                'hevc',
                {},
                {
                    segmentBase: '/segment',
                    itemId: 'item123',
                    fileId: 'source456',
                    subtitleTracks: subs,
                },
            );

            const mediaLines = playlist
                .split('\n')
                .filter((l) => l.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'));
            expect(mediaLines).toHaveLength(2);
            for (const line of mediaLines) expect(line).toContain('fileId=source456');
        });

        it('associates the group with the variant via SUBTITLES="subs"', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                videoInfo,
                'hevc',
                {},
                {
                    segmentBase: '/segment',
                    itemId: 'item123',
                    fileId: 'source456',
                    subtitleTracks: subs,
                },
            );

            const streamInf = playlist.split('\n').find((l) => l.startsWith('#EXT-X-STREAM-INF'));
            expect(streamInf).toContain(',SUBTITLES="subs"');
        });

        it('carries FORCED and DEFAULT through per track', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                videoInfo,
                'hevc',
                {},
                {
                    segmentBase: '/segment',
                    itemId: 'item123',
                    fileId: 'source456',
                    subtitleTracks: subs,
                },
            );

            const mediaLines = playlist
                .split('\n')
                .filter((l) => l.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'));
            expect(mediaLines[0]).toContain('DEFAULT=YES');
            expect(mediaLines[0]).toContain('FORCED=NO');
            expect(mediaLines[1]).toContain('FORCED=YES');
        });

        // Advertising a group whose every rendition would 400 is worse than
        // advertising none — AVPlayer surfaces the tracks, then fails to load them.
        it('advertises nothing when fileId is missing', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                videoInfo,
                'hevc',
                {},
                {
                    segmentBase: '/segment',
                    itemId: 'item123',
                    subtitleTracks: subs,
                },
            );

            expect(playlist).not.toContain('#EXT-X-MEDIA:TYPE=SUBTITLES');
            expect(playlist).not.toContain('SUBTITLES="subs"');
        });

        it('omits the group entirely when there are no text subtitle tracks', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                videoInfo,
                'hevc',
                {},
                {
                    segmentBase: '/segment',
                    itemId: 'item123',
                    fileId: 'source456',
                    subtitleTracks: [],
                },
            );

            expect(playlist).not.toContain('#EXT-X-MEDIA:');
            expect(playlist).not.toContain('SUBTITLES=');
        });

        // Subtitles are a separate MEDIA group, not a variant — adding them must
        // not turn the muxed rendition multi-variant.
        it('still emits exactly one EXT-X-STREAM-INF variant', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                videoInfo,
                'hevc',
                {},
                {
                    segmentBase: '/segment',
                    itemId: 'item123',
                    fileId: 'source456',
                    subtitleTracks: subs,
                },
            );

            expect(playlist.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(1);
        });

        it('coexists with the synthetic I-frame variant', () => {
            const playlist = generateMuxedMasterPlaylist(
                uri,
                40000000,
                videoInfo,
                'hevc',
                { syntheticIframes: true },
                {
                    segmentBase: '/segment',
                    trickplayInfo: {
                        width: 320,
                        height: 180,
                        tileWidth: 10,
                        tileHeight: 10,
                        thumbnailCount: 240,
                        interval: 10000,
                        bandwidth: 100000,
                    },
                    itemId: 'item123',
                    fileId: 'source456',
                    subtitleTracks: subs,
                },
            );

            expect(playlist).toContain('#EXT-X-I-FRAME-STREAM-INF');
            expect(
                playlist.split('\n').filter((l) => l.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')),
            ).toHaveLength(2);
            expect(playlist.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(1);
        });
    });
});

describe('generateAudioOnlyMasterPlaylist', () => {
    const sub: SubtitleTrackInfo = {
        index: 2,
        displayTitle: 'English',
        language: 'eng',
        codec: 'subrip',
        isDefault: true,
        isForced: false,
        isTextBased: true,
    };

    it('omits RESOLUTION (RFC 8216 §4.3.4.2)', () => {
        expect(generateAudioOnlyMasterPlaylist('index.m3u8', AUDIO_ONLY_BANDWIDTH)).not.toContain(
            'RESOLUTION',
        );
    });

    it('declares AAC-LC and no video codec', () => {
        const m = generateAudioOnlyMasterPlaylist('index.m3u8', AUDIO_ONLY_BANDWIDTH);
        expect(m).toContain('CODECS="mp4a.40.2"');
        expect(m).not.toContain('avc1');
    });

    it('emits no AUDIO group', () => {
        const m = generateAudioOnlyMasterPlaylist('index.m3u8', AUDIO_ONLY_BANDWIDTH);
        expect(m).not.toContain('AUDIO=');
        expect(m).not.toContain('TYPE=AUDIO');
    });

    it('emits exactly one variant', () => {
        const m = generateAudioOnlyMasterPlaylist('index.m3u8', AUDIO_ONLY_BANDWIDTH);
        expect(m.match(/#EXT-X-STREAM-INF/g)).toHaveLength(1);
    });

    it('associates subtitles and threads fileId', () => {
        const m = generateAudioOnlyMasterPlaylist(
            'index.m3u8',
            AUDIO_ONLY_BANDWIDTH,
            [sub],
            '/api/playback/x/hls',
            new URLSearchParams({ t: '1' }),
            'file-9',
        );
        expect(m).toContain('TYPE=SUBTITLES');
        expect(m).toContain('SUBTITLES="subs"');
        expect(m).toContain('fileId=file-9');
    });

    it('omits SUBTITLES when there are no renditions', () => {
        expect(
            generateAudioOnlyMasterPlaylist('index.m3u8', AUDIO_ONLY_BANDWIDTH, []),
        ).not.toContain('SUBTITLES=');
    });
});

describe('resolveHevcMain10', () => {
    // The manifest profile_idc must match the real bitstream. Advertising Main 10
    // over a Main stream makes AVFoundation reject playback outright with
    // CoreMediaErrorDomain 1718449215 (FourCC 'fmt?') — seen on tvOS the moment a
    // burn-in subtitle was selected.
    const softwareHevc = {
        isVideoTranscoded: true,
        outputCodec: 'hevc',
        gpuEncoder: undefined,
    };

    it('reports Main (not Main 10) for a burn-in encode', () => {
        // Burn-in composites the overlay on the CPU and hands the encoder 8-bit
        // frames. Probed on prod: hevc, Main, yuv420p.
        expect(resolveHevcMain10({ ...softwareHevc, hasSubtitleBurnIn: true })).toBe(false);
    });

    it('still reports Main 10 for a plain software HEVC transcode', () => {
        expect(resolveHevcMain10({ ...softwareHevc, hasSubtitleBurnIn: false })).toBe(true);
    });

    it('reports Main for a GPU encode', () => {
        expect(resolveHevcMain10({ ...softwareHevc, gpuEncoder: 'hevc_qsv' })).toBe(false);
    });

    it('reports Main when the video is copied rather than transcoded', () => {
        expect(resolveHevcMain10({ ...softwareHevc, isVideoTranscoded: false })).toBe(false);
    });

    it('reports Main for a non-HEVC output', () => {
        expect(resolveHevcMain10({ ...softwareHevc, outputCodec: 'h264' })).toBe(false);
        expect(resolveHevcMain10({ ...softwareHevc, outputCodec: undefined })).toBe(false);
    });

    it('recognises h265 spelling as HEVC', () => {
        expect(resolveHevcMain10({ ...softwareHevc, outputCodec: 'libx265' })).toBe(true);
    });

    // A STREAM-INF may not reference a group that was never declared. The MEDIA
    // lines are gated on itemId+fileId, so a track list without them used to
    // emit SUBTITLES="subs" pointing at nothing.
    it('omits the SUBTITLES group when the media lines were gated out', () => {
        const playlist = generateMasterPlaylist(
            [],
            [
                {
                    index: 2,
                    displayTitle: 'English',
                    language: 'eng',
                    codec: 'subrip',
                    isDefault: true,
                    isForced: false,
                    isTextBased: true,
                },
            ],
            '/segment',
            new URLSearchParams(),
            5_000_000,
            { codec: 'hevc', width: 1920, height: 1080 },
            'hevc',
            'item123',
            undefined, // no fileId -> media lines suppressed
        );

        expect(playlist).not.toContain('#EXT-X-MEDIA:TYPE=SUBTITLES');
        expect(playlist).not.toContain('SUBTITLES="subs"');
    });
});

describe('CODECS on a source with no audio', () => {
    /**
     * The audio half of the CODECS string used to be unconditional: with no
     * audio information it fell back to `mp4a.40.2`. So a video-only stream —
     * a silent film, or one of the video-only renditions this app ships
     * deliberately — advertised an AAC track its segments do not contain.
     *
     * This is the same class of defect as the `hvc1`-vs-samples mismatch this
     * module already documents: AVPlayer requires CODECS to describe the actual
     * samples, and hls.js builds its SourceBuffers from this string, so it
     * waits for an audio track that never arrives. `AUDIO="audio"` was already
     * gated on the MEDIA lines for the same reason — CODECS was simply missed.
     */
    const SDR: MasterPlaylistVideoInfo = {
        width: 1920,
        height: 1080,
        codec: 'h264',
        profile: 'high',
        level: 42,
    };

    const withAudio: AudioTrackInfo[] = [
        {
            index: asAbsoluteStreamIndex(1),
            codec: 'aac',
            language: 'eng',
            displayTitle: 'English',
            channels: 2,
            isDefault: true,
        },
    ];

    const codecsOf = (playlist: string): string =>
        playlist.match(/CODECS="([^"]*)"/)?.[1] ?? '(no CODECS attribute)';

    it('omits the audio codec when there are no audio tracks', () => {
        const playlist = generateMasterPlaylist(
            [],
            [],
            '/api/playback/itm/hls',
            new URLSearchParams(),
            8_000_000,
            SDR,
            'h264',
        );

        expect(codecsOf(playlist)).not.toContain('mp4a');
        expect(codecsOf(playlist)).toContain('avc1');
        // And the stream must still be described — omitting audio must not
        // degenerate into omitting the variant.
        expect(playlist).toContain('#EXT-X-STREAM-INF:');
    });

    it('still advertises the audio codec when audio exists', () => {
        const playlist = generateMasterPlaylist(
            withAudio,
            [],
            '/api/playback/itm/hls',
            new URLSearchParams(),
            8_000_000,
            SDR,
            'h264',
        );

        expect(codecsOf(playlist)).toContain('mp4a.40.2');
    });

    it('lets a muxed master be told the source is silent', () => {
        // This generator is handed a media URI, not a track list, so the caller
        // is the only one who can know.
        const silent = generateMuxedMasterPlaylist('index.m3u8', 8_000_000, SDR, 'h264', {
            hasAudio: false,
        });
        expect(codecsOf(silent)).not.toContain('mp4a');
    });

    it('assumes audio when the caller says nothing (unchanged for every old caller)', () => {
        const unspecified = generateMuxedMasterPlaylist('index.m3u8', 8_000_000, SDR, 'h264');
        expect(codecsOf(unspecified)).toContain('mp4a.40.2');
    });
});
