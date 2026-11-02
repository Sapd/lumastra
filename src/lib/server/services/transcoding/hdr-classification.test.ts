// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HDR Classification & Decision Matrix Tests
 *
 * Tests the classifyHdrSource() shared helper against every HDR variant
 * the system encounters: Jellyfin DB strings, FFprobe-derived strings,
 * Dolby Vision metadata, and edge cases like SDR content with HDR-like
 * field values.
 *
 * These tests would have caught the original SDR HEVC bug where
 * preserve_hdr=true was set for SDR content, injecting BT.2020/PQ
 * color metadata into the fMP4 colr box and causing tvOS AVPlayer
 * to reject the stream with CoreMediaErrorDomain -12927.
 */

import { describe, it, expect } from 'vitest';
import { classifyHdrSource, type Hdr10Metadata } from './types.js';

describe('classifyHdrSource', () => {
    describe('SDR sources — must never classify as HDR', () => {
        it('both fields undefined', () => {
            const r = classifyHdrSource(undefined, undefined);
            expect(r.isHdr).toBe(false);
            expect(r.isHdr10).toBe(false);
            expect(r.isHlg).toBe(false);
            expect(r.isDolbyVision).toBe(false);
        });

        it('explicit SDR strings', () => {
            const r = classifyHdrSource('SDR', 'SDR');
            expect(r.isHdr).toBe(false);
        });

        it('empty strings', () => {
            const r = classifyHdrSource('', '');
            expect(r.isHdr).toBe(false);
        });

        it('SDR with empty metadata (no DV profile)', () => {
            const meta: Hdr10Metadata = {};
            const r = classifyHdrSource('SDR', 'SDR', meta);
            expect(r.isHdr).toBe(false);
        });
    });

    describe('HDR10 sources', () => {
        it('videoRange="HDR10"', () => {
            const r = classifyHdrSource('HDR10', undefined);
            expect(r.isHdr).toBe(true);
            expect(r.isHdr10).toBe(true);
            expect(r.isHlg).toBe(false);
            expect(r.isDolbyVision).toBe(false);
        });

        it('videoRangeType="HDR10"', () => {
            const r = classifyHdrSource(undefined, 'HDR10');
            expect(r.isHdr).toBe(true);
            expect(r.isHdr10).toBe(true);
        });

        it('generic HDR label from videoRange', () => {
            const r = classifyHdrSource('HDR', undefined);
            expect(r.isHdr).toBe(true);
            expect(r.isHdr10).toBe(true);
        });

        it('PQ transfer label', () => {
            const r = classifyHdrSource('PQ', 'PQ');
            expect(r.isHdr).toBe(true);
            expect(r.isHdr10).toBe(true);
        });

        it('case-insensitive: "hdr10"', () => {
            const r = classifyHdrSource('hdr10', 'hdr10');
            expect(r.isHdr).toBe(true);
            expect(r.isHdr10).toBe(true);
        });
    });

    describe('HLG sources', () => {
        it('videoRange="HLG"', () => {
            const r = classifyHdrSource('HLG', undefined);
            expect(r.isHdr).toBe(true);
            expect(r.isHlg).toBe(true);
            expect(r.isHdr10).toBe(false);
        });

        it('videoRangeType="HLG"', () => {
            const r = classifyHdrSource(undefined, 'HLG');
            expect(r.isHdr).toBe(true);
            expect(r.isHlg).toBe(true);
        });

        it('case-insensitive: "hlg"', () => {
            const r = classifyHdrSource('hlg', undefined);
            expect(r.isHdr).toBe(true);
            expect(r.isHlg).toBe(true);
        });
    });

    describe('Dolby Vision sources', () => {
        it('videoRangeType="DOVI"', () => {
            const r = classifyHdrSource(undefined, 'DOVI');
            expect(r.isHdr).toBe(true);
            expect(r.isDolbyVision).toBe(true);
        });

        it('videoRange="Dolby Vision"', () => {
            const r = classifyHdrSource('Dolby Vision', undefined);
            expect(r.isHdr).toBe(true);
            expect(r.isDolbyVision).toBe(true);
        });

        it('videoRange="DolbyVision" (no space)', () => {
            const r = classifyHdrSource('DolbyVision', undefined);
            expect(r.isHdr).toBe(true);
            expect(r.isDolbyVision).toBe(true);
        });

        it('Jellyfin DOVIWithHDR10 range type', () => {
            const r = classifyHdrSource(undefined, 'DOVIWithHDR10');
            expect(r.isHdr).toBe(true);
            expect(r.isDolbyVision).toBe(true);
            // Also matches HDR10 due to the substring
            expect(r.isHdr10).toBe(true);
        });

        it('dvProfile in metadata (no string indicators)', () => {
            const meta: Hdr10Metadata = { dvProfile: 8 };
            const r = classifyHdrSource(undefined, undefined, meta);
            expect(r.isHdr).toBe(true);
            expect(r.isDolbyVision).toBe(true);
        });

        it('DV Profile 5 (no HDR10 base layer)', () => {
            const meta: Hdr10Metadata = { dvProfile: 5 };
            const r = classifyHdrSource(undefined, 'DOVI', meta);
            expect(r.isHdr).toBe(true);
            expect(r.isDolbyVision).toBe(true);
        });

        it('DV Profile 8 with HLG base layer (blCompatId=4)', () => {
            const meta: Hdr10Metadata = { dvProfile: 8, dvBlCompatId: 4 };
            const r = classifyHdrSource(undefined, 'DOVI', meta);
            expect(r.isHdr).toBe(true);
            expect(r.isDolbyVision).toBe(true);
        });
    });

    describe('mixed / compound labels', () => {
        it('HDR10 + HLG both present → both flags set', () => {
            // Unlikely in practice but tests flag independence
            const r = classifyHdrSource('HDR10', 'HLG');
            expect(r.isHdr).toBe(true);
            expect(r.isHdr10).toBe(true);
            expect(r.isHlg).toBe(true);
        });

        it('DOVI + HDR10 (profile 8 cross-compat)', () => {
            const r = classifyHdrSource('HDR10', 'DOVI');
            expect(r.isHdr).toBe(true);
            expect(r.isHdr10).toBe(true);
            expect(r.isDolbyVision).toBe(true);
        });
    });

    describe('regression: SDR content must not trigger HDR flags', () => {
        // This is the exact scenario that caused the tvOS -12927 bug:
        // SDR HEVC content where preserve_hdr was incorrectly set to true,
        // causing BT.2020/PQ color metadata injection into the colr box.

        it('SDR HEVC (Forrest Gump scenario)', () => {
            const r = classifyHdrSource(undefined, 'SDR');
            expect(r.isHdr).toBe(false);
            expect(r.isHdr10).toBe(false);
            expect(r.isHlg).toBe(false);
            expect(r.isDolbyVision).toBe(false);
        });

        it('SDR with no range info at all', () => {
            const r = classifyHdrSource(undefined, undefined, undefined);
            expect(r.isHdr).toBe(false);
        });

        it('SDR with empty metadata object', () => {
            const r = classifyHdrSource('SDR', 'SDR', {});
            expect(r.isHdr).toBe(false);
        });
    });
});
