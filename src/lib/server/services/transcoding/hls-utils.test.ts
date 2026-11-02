// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for HLS Utilities
 */

import { describe, it, expect } from 'vitest';
import {
    isHlsCompatibleAudioCodec,
    requiresAudioTranscode,
    determineAudioAction,
    buildVarStreamMap,
    buildHlsOutputPattern,
    HLS_COMPATIBLE_AUDIO_CODECS,
    HLS_INCOMPATIBLE_AUDIO_CODECS,
} from './hls-utils.js';

describe('HLS Audio Codec Compatibility', () => {
    describe('isHlsCompatibleAudioCodec', () => {
        it('returns true for AAC', () => {
            expect(isHlsCompatibleAudioCodec('aac')).toBe(true);
            expect(isHlsCompatibleAudioCodec('AAC')).toBe(true);
            expect(isHlsCompatibleAudioCodec('Aac')).toBe(true);
        });

        it('returns true for AC3 (Dolby Digital)', () => {
            expect(isHlsCompatibleAudioCodec('ac3')).toBe(true);
            expect(isHlsCompatibleAudioCodec('AC3')).toBe(true);
            expect(isHlsCompatibleAudioCodec('ac-3')).toBe(true);
        });

        it('returns true for EAC3 (Dolby Digital Plus) - all naming variants', () => {
            expect(isHlsCompatibleAudioCodec('eac3')).toBe(true);
            expect(isHlsCompatibleAudioCodec('EAC3')).toBe(true);
            expect(isHlsCompatibleAudioCodec('eac-3')).toBe(true);
            expect(isHlsCompatibleAudioCodec('ec-3')).toBe(true);
            expect(isHlsCompatibleAudioCodec('e-ac-3')).toBe(true);
            expect(isHlsCompatibleAudioCodec('E-AC-3')).toBe(true);
        });

        it('returns true for ALAC (Apple Lossless)', () => {
            expect(isHlsCompatibleAudioCodec('alac')).toBe(true);
            expect(isHlsCompatibleAudioCodec('ALAC')).toBe(true);
        });

        it('returns true for MP3', () => {
            expect(isHlsCompatibleAudioCodec('mp3')).toBe(true);
            expect(isHlsCompatibleAudioCodec('MP3')).toBe(true);
        });

        it('returns false for DTS variants', () => {
            expect(isHlsCompatibleAudioCodec('dts')).toBe(false);
            expect(isHlsCompatibleAudioCodec('DTS')).toBe(false);
            expect(isHlsCompatibleAudioCodec('dts-hd')).toBe(false);
            expect(isHlsCompatibleAudioCodec('dtshd')).toBe(false);
        });

        it('returns false for TrueHD', () => {
            expect(isHlsCompatibleAudioCodec('truehd')).toBe(false);
            expect(isHlsCompatibleAudioCodec('TrueHD')).toBe(false);
        });

        it('returns false for FLAC', () => {
            expect(isHlsCompatibleAudioCodec('flac')).toBe(false);
            expect(isHlsCompatibleAudioCodec('FLAC')).toBe(false);
        });

        it('returns false for undefined/null/empty', () => {
            expect(isHlsCompatibleAudioCodec(undefined)).toBe(false);
            expect(isHlsCompatibleAudioCodec('')).toBe(false);
        });

        it('handles whitespace in codec names', () => {
            expect(isHlsCompatibleAudioCodec(' aac ')).toBe(true);
            expect(isHlsCompatibleAudioCodec('  eac3  ')).toBe(true);
        });
    });

    describe('requiresAudioTranscode', () => {
        it('returns false for HLS-compatible codecs', () => {
            expect(requiresAudioTranscode('aac')).toBe(false);
            expect(requiresAudioTranscode('ac3')).toBe(false);
            expect(requiresAudioTranscode('eac3')).toBe(false);
        });

        it('returns true for incompatible codecs', () => {
            expect(requiresAudioTranscode('dts')).toBe(true);
            expect(requiresAudioTranscode('truehd')).toBe(true);
            expect(requiresAudioTranscode('flac')).toBe(true);
        });

        it('returns true for unknown codecs (safe default)', () => {
            expect(requiresAudioTranscode('unknown_codec')).toBe(true);
            expect(requiresAudioTranscode('xyz123')).toBe(true);
        });

        it('returns true for undefined/empty (safe default)', () => {
            expect(requiresAudioTranscode(undefined)).toBe(true);
            expect(requiresAudioTranscode('')).toBe(true);
        });
    });

    describe('determineAudioAction', () => {
        describe('when requestedAction is "transcode"', () => {
            it('always returns transcode regardless of codec', () => {
                expect(determineAudioAction('aac', 'transcode')).toBe('transcode');
                expect(determineAudioAction('dts', 'transcode')).toBe('transcode');
                expect(determineAudioAction(undefined, 'transcode')).toBe('transcode');
            });
        });

        describe('when requestedAction is "copy"', () => {
            it('returns copy for compatible codecs', () => {
                expect(determineAudioAction('aac', 'copy')).toBe('copy');
                expect(determineAudioAction('ac3', 'copy')).toBe('copy');
                expect(determineAudioAction('eac3', 'copy')).toBe('copy');
            });

            it('returns transcode for incompatible codecs (overrides request)', () => {
                expect(determineAudioAction('dts', 'copy')).toBe('transcode');
                expect(determineAudioAction('truehd', 'copy')).toBe('transcode');
                expect(determineAudioAction('flac', 'copy')).toBe('transcode');
            });

            it('returns transcode for unknown codecs (safe fallback)', () => {
                expect(determineAudioAction('unknown', 'copy')).toBe('transcode');
                expect(determineAudioAction(undefined, 'copy')).toBe('transcode');
            });
        });

        describe('when requestedAction is undefined (auto-detect)', () => {
            it('returns copy for compatible codecs', () => {
                expect(determineAudioAction('aac', undefined)).toBe('copy');
                expect(determineAudioAction('ac3', undefined)).toBe('copy');
                expect(determineAudioAction('eac3', undefined)).toBe('copy');
            });

            it('returns transcode for incompatible codecs', () => {
                expect(determineAudioAction('dts', undefined)).toBe('transcode');
                expect(determineAudioAction('truehd', undefined)).toBe('transcode');
            });

            it('returns transcode for unknown/missing codec', () => {
                expect(determineAudioAction('unknown', undefined)).toBe('transcode');
                expect(determineAudioAction(undefined, undefined)).toBe('transcode');
            });
        });
    });
});

describe('var_stream_map Building', () => {
    describe('buildVarStreamMap', () => {
        it('builds correct map for single audio track', () => {
            const result = buildVarStreamMap([{ language: 'eng', isDefault: true }]);

            expect(result).toHaveLength(2);
            expect(result[0]).toBe('a:0,agroup:audio,language:eng,name:0,default:yes');
            expect(result[1]).toBe('v:0,agroup:audio,name:1');
        });

        it('builds correct map for multiple audio tracks', () => {
            const result = buildVarStreamMap([
                { language: 'eng', isDefault: true },
                { language: 'ger', isDefault: false }, // Use 'ger' as normalizer converts 'deu' to 'ger'
                { language: 'fre', isDefault: false }, // Use 'fre' as normalizer converts 'fra' to 'fre'
            ]);

            expect(result).toHaveLength(4);
            expect(result[0]).toBe('a:0,agroup:audio,language:eng,name:0,default:yes');
            expect(result[1]).toBe('a:1,agroup:audio,language:ger,name:1,default:no');
            expect(result[2]).toBe('a:2,agroup:audio,language:fre,name:2,default:no');
            expect(result[3]).toBe('v:0,agroup:audio,name:3');
        });

        it('handles undefined language (uses "und")', () => {
            const result = buildVarStreamMap([{ language: undefined, isDefault: true }]);

            expect(result[0]).toContain('language:und');
        });

        it('handles empty audio tracks (video-only output)', () => {
            const result = buildVarStreamMap([]);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe('v:0,agroup:audio,name:0');
        });

        it('normalizes language codes', () => {
            const result = buildVarStreamMap([{ language: 'English', isDefault: true }]);

            // Should normalize to ISO 639 code
            expect(result[0]).toContain('language:eng');
        });

        it('uses source isDefault flag (non-English default)', () => {
            const result = buildVarStreamMap([
                { language: 'ger', isDefault: true },
                { language: 'eng', isDefault: false },
            ]);

            expect(result[0]).toBe('a:0,agroup:audio,language:ger,name:0,default:yes');
            expect(result[1]).toBe('a:1,agroup:audio,language:eng,name:1,default:no');
        });
    });

    describe('buildHlsOutputPattern', () => {
        it('builds correct output pattern', () => {
            const result = buildHlsOutputPattern('/tmp/transcode/abc123');

            expect(result).toHaveLength(3);
            expect(result[0]).toBe('-hls_segment_filename');
            expect(result[1]).toContain('/tmp/transcode/abc123');
            expect(result[1]).toContain('stream_%v');
            expect(result[1]).toContain('segment_%05d.m4s');
            expect(result[2]).toContain('/tmp/transcode/abc123');
            expect(result[2]).toContain('stream_%v');
            expect(result[2]).toContain('index.m3u8');
        });
    });
});

describe('Codec Sets', () => {
    it('HLS_COMPATIBLE_AUDIO_CODECS contains expected codecs', () => {
        const expected = ['aac', 'ac3', 'ac-3', 'eac3', 'eac-3', 'ec-3', 'e-ac-3', 'alac', 'mp3'];
        for (const codec of expected) {
            expect(HLS_COMPATIBLE_AUDIO_CODECS.has(codec)).toBe(true);
        }
    });

    it('HLS_INCOMPATIBLE_AUDIO_CODECS contains expected codecs', () => {
        const expected = ['truehd', 'dts', 'dts-hd', 'flac', 'pcm', 'opus', 'vorbis'];
        for (const codec of expected) {
            expect(HLS_INCOMPATIBLE_AUDIO_CODECS.has(codec)).toBe(true);
        }
    });

    it('compatible and incompatible sets do not overlap', () => {
        for (const codec of HLS_COMPATIBLE_AUDIO_CODECS) {
            expect(HLS_INCOMPATIBLE_AUDIO_CODECS.has(codec)).toBe(false);
        }
    });
});
