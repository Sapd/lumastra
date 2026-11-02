// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit Tests for Lumastra Info Utilities
 *
 * Tests buildHlsUrl() and parseCapsParam().
 * Compatibility logic tests are in media-compatibility.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
    buildHlsUrl,
    parseCapsParam,
    parsePathScopedCaps,
    parseCapsAuto,
    normalizeHdrToken,
} from './info.utils.js';

// ---------------------------------------------------------------------------
// buildHlsUrl
// ---------------------------------------------------------------------------

describe('buildHlsUrl', () => {
    const BASE = 'http://localhost:3000';
    const ITEM_ID = 'abc-123-uuid';

    it('builds a full_transcode URL', () => {
        const url = buildHlsUrl(BASE, ITEM_ID, 'h264', 'aac');
        expect(url).toBe(`${BASE}/api/playback/${ITEM_ID}/hls?videoCodec=h264&audioCodec=aac`);
    });

    it('builds a remux URL (copy codecs)', () => {
        const url = buildHlsUrl(BASE, ITEM_ID, 'copy', 'copy');
        expect(url).toBe(`${BASE}/api/playback/${ITEM_ID}/hls?videoCodec=copy&audioCodec=copy`);
    });

    it('appends fileId when provided', () => {
        const url = buildHlsUrl(BASE, ITEM_ID, 'h264', 'aac', 'ver-xyz');
        expect(url).toContain('fileId=ver-xyz');
    });

    it('omits fileId when not provided', () => {
        const url = buildHlsUrl(BASE, ITEM_ID, 'h264', 'aac');
        expect(url).not.toContain('fileId');
    });

    it('does not include stale transcodeMode param', () => {
        const url = buildHlsUrl(BASE, ITEM_ID, 'copy', 'aac');
        expect(url).not.toContain('transcodeMode');
    });
});

// ---------------------------------------------------------------------------
// parseCapsParam
// ---------------------------------------------------------------------------

describe('parseCapsParam', () => {
    it('parses a full caps string with all sections', () => {
        const caps = parseCapsParam('v:h264,hevc,av1;a:aac,opus;c:mp4,webm;h:hdr10,hlg');
        expect(caps).toBeDefined();
        expect(caps!.videoCodecs).toEqual(new Set(['h264', 'hevc', 'av1']));
        expect(caps!.audioCodecs).toEqual(new Set(['aac', 'opus']));
        expect(caps!.containers).toEqual(new Set(['mp4', 'webm']));
        expect(caps!.hdrFormats).toEqual(new Set(['hdr10', 'hlg']));
    });

    it('parses video and audio only (no containers or hdr)', () => {
        const caps = parseCapsParam('v:h264;a:aac');
        expect(caps).toBeDefined();
        expect(caps!.videoCodecs).toEqual(new Set(['h264']));
        expect(caps!.audioCodecs).toEqual(new Set(['aac']));
    });

    it('parses new fields: ha (hlsAudioCodecs), as (canSwitchAudioInDirectPlay)', () => {
        const caps = parseCapsParam('v:h264;a:aac;ha:aac,ac3,eac3;as:1');
        expect(caps).toBeDefined();
        expect(caps!.hlsAudioCodecs).toEqual(new Set(['aac', 'ac3', 'eac3']));
        expect(caps!.canSwitchAudioInDirectPlay).toBe(true);
    });

    it('defaults canSwitchAudioInDirectPlay to false when not present', () => {
        const caps = parseCapsParam('v:h264;a:aac');
        expect(caps).toBeDefined();
        expect(caps!.canSwitchAudioInDirectPlay).toBe(false);
    });

    it('defaults hlsAudioCodecs to undefined when not present', () => {
        const caps = parseCapsParam('v:h264;a:aac');
        expect(caps).toBeDefined();
        expect(caps!.hlsAudioCodecs).toBeUndefined();
    });

    it('returns undefined for null input', () => {
        expect(parseCapsParam(null)).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
        expect(parseCapsParam(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
        expect(parseCapsParam('')).toBeUndefined();
    });

    it('returns undefined when no video or audio codecs present', () => {
        expect(parseCapsParam('c:mp4;h:hdr10')).toBeUndefined();
    });

    it('returns undefined for malformed input with no colons', () => {
        expect(parseCapsParam('garbage')).toBeUndefined();
    });

    it('returns undefined for semicolons only', () => {
        expect(parseCapsParam(';;;')).toBeUndefined();
    });

    it('lowercases codec values', () => {
        const caps = parseCapsParam('v:H264,HEVC;a:AAC');
        expect(caps).toBeDefined();
        expect(caps!.videoCodecs).toEqual(new Set(['h264', 'hevc']));
        expect(caps!.audioCodecs).toEqual(new Set(['aac']));
    });

    it('trims whitespace in codec values', () => {
        const caps = parseCapsParam('v: h264 , hevc ;a: aac ');
        expect(caps).toBeDefined();
        expect(caps!.videoCodecs).toEqual(new Set(['h264', 'hevc']));
        expect(caps!.audioCodecs).toEqual(new Set(['aac']));
    });

    it('deduplicates codec values', () => {
        const caps = parseCapsParam('v:h264,h264,h264;a:aac,aac');
        expect(caps).toBeDefined();
        expect(caps!.videoCodecs.size).toBe(1);
        expect(caps!.audioCodecs.size).toBe(1);
    });

    it('ignores unknown prefix sections', () => {
        const caps = parseCapsParam('v:h264;a:aac;x:foo;z:bar');
        expect(caps).toBeDefined();
        expect(caps!.videoCodecs).toEqual(new Set(['h264']));
        expect(caps!.audioCodecs).toEqual(new Set(['aac']));
    });

    it('returns undefined for excessively long input (>500 chars)', () => {
        const long = 'v:' + 'h264,'.repeat(200) + ';a:aac';
        expect(parseCapsParam(long)).toBeUndefined();
    });

    // Regression: the browser serializes Dolby Vision as `dolby_vision`, but the
    // planner keys DV support on `dovi` (hdrFormats.has('dovi')). If the parser
    // stored the raw `dolby_vision` token, a DV-capable client would be read as
    // non-DV → the planner forces a transcode/tonemap for DV sources, which then
    // fights the client's own direct-play (copy) request and flip-flops the job
    // (black screen). The parser must normalize dolby_vision → dovi.
    it('normalizes the client dolby_vision HDR token to dovi', () => {
        const caps = parseCapsParam('v:hevc;a:aac;h:hdr10,hlg,dolby_vision');
        expect(caps).toBeDefined();
        expect(caps!.hdrFormats).toEqual(new Set(['hdr10', 'hlg', 'dovi']));
        expect(caps!.hdrFormats!.has('dovi')).toBe(true);
        expect(caps!.hdrFormats!.has('dolby_vision')).toBe(false);
    });

    it('leaves an already-canonical dovi token unchanged (idempotent)', () => {
        const caps = parseCapsParam('v:hevc;a:aac;h:dovi');
        expect(caps!.hdrFormats).toEqual(new Set(['dovi']));
    });
});

// ---------------------------------------------------------------------------
// normalizeHdrToken
// ---------------------------------------------------------------------------

describe('normalizeHdrToken', () => {
    it('maps dolby_vision to dovi', () => {
        expect(normalizeHdrToken('dolby_vision')).toBe('dovi');
    });

    it('passes through other HDR tokens unchanged', () => {
        expect(normalizeHdrToken('dovi')).toBe('dovi');
        expect(normalizeHdrToken('hdr10')).toBe('hdr10');
        expect(normalizeHdrToken('hlg')).toBe('hlg');
        expect(normalizeHdrToken('hdr10plus')).toBe('hdr10plus');
    });
});

// ---------------------------------------------------------------------------
// parsePathScopedCaps — Dolby Vision round-trip
// ---------------------------------------------------------------------------

describe('parsePathScopedCaps Dolby Vision normalization', () => {
    const psWithDv =
        'ps:df={v:hevc;a:aac;c:mp4},nh={v:hevc;a:aac},mh={v:hevc;a:aac};h:hdr10,dolby_vision';

    it('normalizes dolby_vision → dovi in the flat deviceCaps.hdrFormats', () => {
        const { deviceCaps } = parsePathScopedCaps(psWithDv);
        expect(deviceCaps.hdrFormats).toBeDefined();
        expect(deviceCaps.hdrFormats!.has('dovi')).toBe(true);
        expect(deviceCaps.hdrFormats!.has('dolby_vision')).toBe(false);
    });

    it('round-trips the canonical dovi back to dolby_vision in pathScoped.hdr.decode', () => {
        const { pathScoped } = parsePathScopedCaps(psWithDv);
        expect(pathScoped).toBeDefined();
        expect(pathScoped!.hdr.decode).toContain('dolby_vision');
        expect(pathScoped!.hdr.decode).not.toContain('dovi');
    });

    it('parseCapsAuto routes a ps: string through the path-scoped parser and normalizes DV', () => {
        const parsed = parseCapsAuto(psWithDv);
        expect(parsed?.deviceCaps.hdrFormats!.has('dovi')).toBe(true);
    });
});
