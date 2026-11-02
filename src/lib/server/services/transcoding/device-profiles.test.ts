// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for DeviceProfileService
 *
 * Tests profile loading, User-Agent matching, direct-play checks,
 * and codec condition evaluation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceProfileService, DEFAULT_PROFILE } from './device-profiles';
import type { DeviceProfile } from './types.js';

describe('DeviceProfileService', () => {
    let service: DeviceProfileService;

    beforeEach(() => {
        service = new DeviceProfileService();
    });

    describe('loadProfiles', () => {
        it('loads without error', async () => {
            await expect(service.loadProfiles()).resolves.toBeUndefined();
        });

        it('loads bundled profiles + default', async () => {
            await service.loadProfiles();
            const profiles = await service.getAllProfiles();
            const ids = profiles.map((p) => p.id);

            expect(ids).toContain('apple-tv');
            expect(ids).toContain('chrome');
            expect(ids).toContain('android-tv');
            expect(ids).toContain('roku');
            expect(ids).toContain('tizen');
            expect(ids).toContain('webos');
            expect(ids).toContain('default');
        });

        it('is idempotent (second call is no-op)', async () => {
            await service.loadProfiles();
            const first = await service.getAllProfiles();

            await service.loadProfiles();
            const second = await service.getAllProfiles();

            expect(second.length).toBe(first.length);
            expect(second.map((p) => p.id)).toEqual(first.map((p) => p.id));
        });
    });

    describe('reloadProfiles', () => {
        it('reloads profiles after clearing', async () => {
            await service.loadProfiles();
            const first = await service.getAllProfiles();
            expect(first.length).toBeGreaterThan(0);

            await service.reloadProfiles();
            const second = await service.getAllProfiles();
            expect(second.length).toBeGreaterThan(0);
            expect(second.map((p) => p.id)).toEqual(first.map((p) => p.id));
        });
    });

    describe('getProfile', () => {
        it('returns profile by ID', async () => {
            const profile = await service.getProfile('chrome');
            expect(profile.id).toBe('chrome');
        });

        it('falls back to default for unknown ID', async () => {
            const profile = await service.getProfile('unknown-device');
            expect(profile.id).toBe('default');
        });

        it('apple-tv profile still loads correctly', async () => {
            const profile = await service.getProfile('apple-tv');
            expect(profile.id).toBe('apple-tv');
            expect(profile.DirectPlayProfiles.length).toBeGreaterThan(0);
        });

        // Regression: tizen.json's CodecProfiles only carry 'DOVIWithHDR10' /
        // 'DOVIWithHLG' / 'DOVIWithSDR' VideoRangeType tokens — these mean the
        // device plays the HDR10/HLG/SDR BASE LAYER only, not real DV decode.
        // Only a bare 'DOVI' or 'DolbyVision' token means the client can
        // actually decode Dolby Vision. detectDolbyVisionSupport must not treat
        // 'DOVIWith*' as DV support.
        it('tizen profile: supportsDolbyVision is false (only DOVIWith* base-layer tokens present)', async () => {
            const profile = await service.getProfile('tizen');
            expect(profile.supportsDolbyVision).toBe(false);
            // Sanity: tizen DOES support HDR (HDR10/HLG tokens are present),
            // so this isn't just a case of HDR detection being broken too.
            expect(profile.supportsHdr).toBe(true);
        });
    });

    describe('getProfileByUserAgent', () => {
        it('matches Apple TV UA', async () => {
            const profile = await service.getProfileByUserAgent('AppleTV11,1/11.1');
            expect(profile.id).toBe('apple-tv');
        });

        it('matches Android TV UA', async () => {
            const profile = await service.getProfileByUserAgent(
                'Mozilla/5.0 (Linux; Android 10; SHIELD Android TV)',
            );
            expect(profile.id).toBe('android-tv');
        });

        it('matches Chrome UA', async () => {
            const profile = await service.getProfileByUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            );
            expect(profile.id).toBe('chrome');
        });

        it('returns default for unknown UA', async () => {
            const profile = await service.getProfileByUserAgent('SomeRandomBot/1.0');
            expect(profile.id).toBe('chrome');
        });

        it('empty string returns default', async () => {
            const profile = await service.getProfileByUserAgent('');
            expect(profile.id).toBe('chrome');
        });

        // Regression: LG WebOS TVs identify with a DIGIT ZERO ("Web0S"), not
        // the letter O ("WebOS"), in their User-Agent string.
        it('matches LG WebOS UA (spelled "Web0S" with a digit zero)', async () => {
            const profile = await service.getProfileByUserAgent(
                'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) ' +
                    'Version/2.1 Safari/537.36 WebAppManager',
            );
            expect(profile.id).toBe('webos');
        });
    });

    describe('canDirectPlay', () => {
        const makeProfile = (
            directPlayProfiles: DeviceProfile['DirectPlayProfiles'],
        ): DeviceProfile => ({
            id: 'test',
            DirectPlayProfiles: directPlayProfiles,
            TranscodingProfiles: [],
            ContainerProfiles: [],
            CodecProfiles: [],
            SubtitleProfiles: [],
        });

        it('returns true on container match', () => {
            const profile = makeProfile([{ Container: 'mp4,mkv', Type: 'Video' }]);
            expect(service.canDirectPlay(profile, 'mp4')).toBe(true);
            expect(service.canDirectPlay(profile, 'mkv')).toBe(true);
        });

        it('returns true on video codec match', () => {
            const profile = makeProfile([
                {
                    Container: 'mp4',
                    Type: 'Video',
                    VideoCodec: 'h264,hevc',
                },
            ]);
            expect(service.canDirectPlay(profile, 'mp4', 'h264')).toBe(true);
            expect(service.canDirectPlay(profile, 'mp4', 'hevc')).toBe(true);
        });

        it('returns true on audio codec match', () => {
            const profile = makeProfile([
                {
                    Container: 'mp4',
                    Type: 'Video',
                    VideoCodec: 'h264',
                    AudioCodec: 'aac,opus',
                },
            ]);
            expect(service.canDirectPlay(profile, 'mp4', 'h264', 'aac')).toBe(true);
            expect(service.canDirectPlay(profile, 'mp4', 'h264', 'opus')).toBe(true);
        });

        it('returns false when no match', () => {
            const profile = makeProfile([
                {
                    Container: 'mp4',
                    Type: 'Video',
                    VideoCodec: 'h264',
                    AudioCodec: 'aac',
                },
            ]);
            expect(service.canDirectPlay(profile, 'mkv')).toBe(false);
            expect(service.canDirectPlay(profile, 'mp4', 'vp9')).toBe(false);
            expect(service.canDirectPlay(profile, 'mp4', 'h264', 'opus')).toBe(false);
        });

        it('returns false when DirectPlayProfiles is missing', () => {
            const profile = makeProfile(
                undefined as unknown as DeviceProfile['DirectPlayProfiles'],
            );
            expect(service.canDirectPlay(profile, 'mp4')).toBe(false);
        });
    });

    describe('checkCodecConditions', () => {
        const makeProfile = (codecProfiles: DeviceProfile['CodecProfiles']): DeviceProfile => ({
            id: 'test',
            DirectPlayProfiles: [],
            TranscodingProfiles: [],
            ContainerProfiles: [],
            CodecProfiles: codecProfiles,
            SubtitleProfiles: [],
        });

        it('Equals pass', () => {
            const profile = makeProfile([
                {
                    Type: 'Video',
                    Codec: 'h264',
                    Conditions: [
                        {
                            Condition: 'Equals',
                            Property: 'VideoProfile',
                            Value: 'high',
                            IsRequired: true,
                        },
                    ],
                },
            ]);
            const result = service.checkCodecConditions(profile, 'h264', {
                VideoProfile: 'high',
            });
            expect(result.pass).toBe(true);
            expect(result.failedConditions).toEqual([]);
        });

        it('Equals fail', () => {
            const profile = makeProfile([
                {
                    Type: 'Video',
                    Codec: 'h264',
                    Conditions: [
                        {
                            Condition: 'Equals',
                            Property: 'VideoProfile',
                            Value: 'high',
                            IsRequired: true,
                        },
                    ],
                },
            ]);
            const result = service.checkCodecConditions(profile, 'h264', {
                VideoProfile: 'baseline',
            });
            expect(result.pass).toBe(false);
            expect(result.failedConditions.length).toBe(1);
        });

        it('NotEquals pass', () => {
            const profile = makeProfile([
                {
                    Type: 'Video',
                    Codec: 'h264',
                    Conditions: [
                        {
                            Condition: 'NotEquals',
                            Property: 'VideoProfile',
                            Value: 'baseline',
                            IsRequired: true,
                        },
                    ],
                },
            ]);
            const result = service.checkCodecConditions(profile, 'h264', {
                VideoProfile: 'high',
            });
            expect(result.pass).toBe(true);
            expect(result.failedConditions).toEqual([]);
        });

        it('NotEquals fail', () => {
            const profile = makeProfile([
                {
                    Type: 'Video',
                    Codec: 'h264',
                    Conditions: [
                        {
                            Condition: 'NotEquals',
                            Property: 'VideoProfile',
                            Value: 'baseline',
                            IsRequired: true,
                        },
                    ],
                },
            ]);
            const result = service.checkCodecConditions(profile, 'h264', {
                VideoProfile: 'baseline',
            });
            expect(result.pass).toBe(false);
            expect(result.failedConditions.length).toBe(1);
        });

        it('EqualsAny pass', () => {
            const profile = makeProfile([
                {
                    Type: 'Video',
                    Codec: 'hevc',
                    Conditions: [
                        {
                            Condition: 'EqualsAny',
                            Property: 'VideoRangeType',
                            Value: 'SDR|HDR10',
                            IsRequired: true,
                        },
                    ],
                },
            ]);
            const result = service.checkCodecConditions(profile, 'hevc', {
                VideoRangeType: 'HDR10',
            });
            expect(result.pass).toBe(true);
            expect(result.failedConditions).toEqual([]);
        });

        it('EqualsAny fail', () => {
            const profile = makeProfile([
                {
                    Type: 'Video',
                    Codec: 'hevc',
                    Conditions: [
                        {
                            Condition: 'EqualsAny',
                            Property: 'VideoRangeType',
                            Value: 'SDR|HDR10',
                            IsRequired: true,
                        },
                    ],
                },
            ]);
            const result = service.checkCodecConditions(profile, 'hevc', {
                VideoRangeType: 'DolbyVision',
            });
            expect(result.pass).toBe(false);
            expect(result.failedConditions.length).toBe(1);
        });

        it('LessThanEqual pass', () => {
            const profile = makeProfile([
                {
                    Type: 'Video',
                    Codec: 'h264',
                    Conditions: [
                        {
                            Condition: 'LessThanEqual',
                            Property: 'Width',
                            Value: '1920',
                            IsRequired: true,
                        },
                    ],
                },
            ]);
            const result = service.checkCodecConditions(profile, 'h264', {
                Width: 1920,
            });
            expect(result.pass).toBe(true);
            expect(result.failedConditions).toEqual([]);
        });

        it('LessThanEqual fail', () => {
            const profile = makeProfile([
                {
                    Type: 'Video',
                    Codec: 'h264',
                    Conditions: [
                        {
                            Condition: 'LessThanEqual',
                            Property: 'Width',
                            Value: '1920',
                            IsRequired: true,
                        },
                    ],
                },
            ]);
            const result = service.checkCodecConditions(profile, 'h264', {
                Width: 3840,
            });
            expect(result.pass).toBe(false);
            expect(result.failedConditions.length).toBe(1);
        });

        it('GreaterThanEqual pass', () => {
            const profile = makeProfile([
                {
                    Type: 'Audio',
                    Codec: 'aac',
                    Conditions: [
                        {
                            Condition: 'GreaterThanEqual',
                            Property: 'AudioChannels',
                            Value: '2',
                            IsRequired: true,
                        },
                    ],
                },
            ]);
            const result = service.checkCodecConditions(profile, 'aac', {
                AudioChannels: 6,
            });
            expect(result.pass).toBe(true);
            expect(result.failedConditions).toEqual([]);
        });

        it('GreaterThanEqual fail', () => {
            const profile = makeProfile([
                {
                    Type: 'Audio',
                    Codec: 'aac',
                    Conditions: [
                        {
                            Condition: 'GreaterThanEqual',
                            Property: 'AudioChannels',
                            Value: '2',
                            IsRequired: true,
                        },
                    ],
                },
            ]);
            const result = service.checkCodecConditions(profile, 'aac', {
                AudioChannels: 1,
            });
            expect(result.pass).toBe(false);
            expect(result.failedConditions.length).toBe(1);
        });

        it('defaults unknown condition to true', () => {
            const profile = makeProfile([
                {
                    Type: 'Video',
                    Codec: 'h264',
                    Conditions: [
                        {
                            Condition:
                                'UnknownCondition' as import('./types.js').ProfileConditionType,
                            Property: 'Width',
                            Value: '1920',
                            IsRequired: true,
                        },
                    ],
                },
            ]);
            const result = service.checkCodecConditions(profile, 'h264', {
                Width: 3840,
            });
            expect(result.pass).toBe(true);
            expect(result.failedConditions).toEqual([]);
        });

        it('passes when CodecProfiles is empty', () => {
            const profile = makeProfile([]);
            const result = service.checkCodecConditions(profile, 'h264', {
                VideoProfile: 'high',
            });
            expect(result.pass).toBe(true);
            expect(result.failedConditions).toEqual([]);
        });

        // Regression: Jellyfin's CodecProfile.Codec may be a comma-separated
        // list (e.g. "ac3,eac3"). checkCodecConditions must match the target
        // codec against EVERY entry in the list, not just an exact string match.
        it('comma-list Codec: matches any codec in the list', () => {
            const profile = makeProfile([
                {
                    Type: 'VideoAudio',
                    Codec: 'ac3,eac3',
                    Conditions: [
                        {
                            Condition: 'LessThanEqual',
                            Property: 'AudioChannels',
                            Value: '6',
                            IsRequired: false,
                        },
                    ],
                },
            ]);
            const eac3Result = service.checkCodecConditions(profile, 'eac3', {
                AudioChannels: 8,
            });
            expect(eac3Result.pass).toBe(false);
            expect(eac3Result.failedConditions.length).toBe(1);

            // 'aac' is not in the "ac3,eac3" list — profile does not apply, passes.
            const aacResult = service.checkCodecConditions(profile, 'aac', {
                AudioChannels: 8,
            });
            expect(aacResult.pass).toBe(true);
            expect(aacResult.failedConditions).toEqual([]);
        });

        // Regression: CodecProfile.Container scoping ("-mp4,ts" = all
        // containers EXCEPT mp4/ts) must be honoured — a profile that doesn't
        // apply to the media's container must be skipped entirely.
        it('container exclusion: profile is skipped for excluded containers', () => {
            const profile = makeProfile([
                {
                    Type: 'Video',
                    Codec: 'hevc',
                    Container: '-mp4,ts',
                    Conditions: [
                        {
                            Condition: 'EqualsAny',
                            Property: 'VideoProfile',
                            Value: 'main',
                            IsRequired: false,
                        },
                    ],
                },
            ]);
            // mp4 is excluded by "-mp4,ts" → profile does not apply → passes
            // regardless of VideoProfile.
            const mp4Result = service.checkCodecConditions(
                profile,
                'hevc',
                { VideoProfile: 'main 10' },
                'mp4',
            );
            expect(mp4Result.pass).toBe(true);
            expect(mp4Result.failedConditions).toEqual([]);

            // mkv is NOT excluded → profile applies → 'main 10' fails EqualsAny 'main'.
            const mkvResult = service.checkCodecConditions(
                profile,
                'hevc',
                { VideoProfile: 'main 10' },
                'mkv',
            );
            expect(mkvResult.pass).toBe(false);
            expect(mkvResult.failedConditions.length).toBe(1);
        });
    });

    describe('DEFAULT_PROFILE export', () => {
        it('has expected default id and properties', () => {
            expect(DEFAULT_PROFILE.id).toBe('default');
            expect(DEFAULT_PROFILE.DirectPlayProfiles.length).toBeGreaterThan(0);
            expect(DEFAULT_PROFILE.CodecProfiles).toEqual([]);
        });

        // Regression: DEFAULT_PROFILE serves UNKNOWN devices. Chrome-class
        // browsers only decode HEVC with hardware support, so falsely
        // advertising HEVC direct play here would produce undecodable output
        // on plain software-decode browsers. Transcoding always works; a
        // false direct-play claim does not.
        it('does not advertise HEVC direct play', () => {
            for (const dp of DEFAULT_PROFILE.DirectPlayProfiles) {
                const codecs = (dp.VideoCodec ?? '').split(',').map((c) => c.trim().toLowerCase());
                expect(codecs).not.toContain('hevc');
                expect(codecs).not.toContain('h265');
            }
        });

        it('supportsHdr is false (conservative default for unknown devices)', () => {
            expect(DEFAULT_PROFILE.supportsHdr).toBe(false);
        });
    });
});
