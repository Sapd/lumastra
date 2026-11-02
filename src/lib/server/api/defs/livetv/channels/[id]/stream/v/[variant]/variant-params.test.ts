// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { parseVariant, rewriteVariantPlaylist, variantAuthQuery } from './variant-params.js';

describe('compat variant route helpers', () => {
    it('accepts only the two variants', () => {
        expect(parseVariant('fmp4')).toBe('fmp4');
        expect(parseVariant('h264')).toBe('h264');
        expect(parseVariant('540p2m')).toBeNull();
        expect(parseVariant(undefined)).toBeNull();
    });

    it('rewrites the init segment and the segments to absolute routes with auth', () => {
        const base = '/api/v1/livetv/channels/c1/stream/v/fmp4';
        const query = variantAuthQuery(new URL('http://x/p?PlaySessionId=live-session&grant=a+b'));
        expect(query).toBe('?PlaySessionId=live-session&grant=a+b');
        const body = [
            '#EXTM3U',
            '#EXT-X-VERSION:6',
            '#EXT-X-MAP:URI="init.mp4"',
            '#EXTINF:4.800,',
            'segment-7.m4s',
            '',
        ].join('\n');
        expect(rewriteVariantPlaylist(body, base, query)).toBe(
            [
                '#EXTM3U',
                '#EXT-X-VERSION:6',
                `#EXT-X-MAP:URI="${base}/init.mp4?PlaySessionId=live-session&grant=a+b"`,
                '#EXTINF:4.800,',
                `${base}/segment-7.m4s?PlaySessionId=live-session&grant=a+b`,
                '',
            ].join('\n'),
        );
    });

    it('rewrites MPEG-TS segment names for the H.264 variant', () => {
        expect(rewriteVariantPlaylist('segment-3.ts\n', '/b', '')).toBe('/b/segment-3.ts\n');
    });
    it('rewrites every init generation after a failover', () => {
        const body =
            '#EXT-X-MAP:URI="init.mp4"\nsegment-7.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init-1.mp4"\nsegment-8.m4s\n';
        expect(rewriteVariantPlaylist(body, '/b', '?k=1')).toBe(
            '#EXT-X-MAP:URI="/b/init.mp4?k=1"\n/b/segment-7.m4s?k=1\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="/b/init-1.mp4?k=1"\n/b/segment-8.m4s?k=1\n',
        );
    });
});
