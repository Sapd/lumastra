// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';

/**
 * Test the M3U8 URL rewriting logic used in the master.m3u8 proxy route.
 * This is the critical transformation that ensures browsers fetch segments
 * through SvelteKit rather than directly from the internal proxy.
 */
describe('HLS M3U8 URL Rewriting', () => {
    function rewriteM3u8(m3u8Text: string, channelId: string): string {
        return m3u8Text.replace(
            /^(segment-\d+\.ts)$/gm,
            `/api/livetv/channels/${channelId}/stream/$1`,
        );
    }

    it('rewrites segment URLs to SvelteKit routes', () => {
        const input = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            '#EXT-X-TARGETDURATION:4',
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXTINF:4.000,',
            'segment-0.ts',
            '#EXTINF:4.000,',
            'segment-1.ts',
            '#EXTINF:3.500,',
            'segment-2.ts',
            '',
        ].join('\n');

        const result = rewriteM3u8(input, 'my-channel-id');

        expect(result).toContain('/api/livetv/channels/my-channel-id/stream/segment-0.ts');
        expect(result).toContain('/api/livetv/channels/my-channel-id/stream/segment-1.ts');
        expect(result).toContain('/api/livetv/channels/my-channel-id/stream/segment-2.ts');
        // M3U8 directives should remain unchanged
        expect(result).toContain('#EXTM3U');
        expect(result).toContain('#EXT-X-TARGETDURATION:4');
        expect(result).toContain('#EXTINF:4.000,');
    });

    it('handles high segment indices', () => {
        const input = '#EXTINF:4.000,\nsegment-12345.ts\n';
        const result = rewriteM3u8(input, 'ch1');
        expect(result).toContain('/api/livetv/channels/ch1/stream/segment-12345.ts');
    });

    it('does not rewrite non-segment lines', () => {
        const input = '#EXTM3U\n#EXT-X-DISCONTINUITY\nother-file.ts\n';
        const result = rewriteM3u8(input, 'ch1');
        expect(result).toContain('other-file.ts');
        expect(result).not.toContain('/api/livetv/channels/ch1/stream/other-file.ts');
    });

    it('handles discontinuity markers', () => {
        const input = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            '#EXT-X-TARGETDURATION:4',
            '#EXT-X-MEDIA-SEQUENCE:5',
            '#EXT-X-DISCONTINUITY',
            '#EXTINF:4.000,',
            'segment-5.ts',
            '#EXTINF:4.000,',
            'segment-6.ts',
            '',
        ].join('\n');

        const result = rewriteM3u8(input, 'ch1');
        expect(result).toContain('#EXT-X-DISCONTINUITY');
        expect(result).toContain('/api/livetv/channels/ch1/stream/segment-5.ts');
        expect(result).toContain('/api/livetv/channels/ch1/stream/segment-6.ts');
    });
});
