// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HlsPlaylistBuilder joins every pushed line with '\n'. `segment` /
 * `segmentWithByteRange` / `raw` take caller-supplied uri/title/line values
 * that, on the trickplay path, are built from request query parameters
 * (fileId, stream_token). A value containing a literal CR or LF would inject
 * extra playlist lines — including a forged HLS tag such as a second
 * `#EXT-X-ENDLIST` — splitting one intended line into several. These tests
 * pin that CR/LF is stripped before the value reaches the playlist body.
 */

import { describe, it, expect } from 'vitest';
import { HlsPlaylistBuilder } from './hls-definitions.js';

describe('HlsPlaylistBuilder CRLF stripping', () => {
    it('segment() strips CR/LF from both uri and title', () => {
        const builder = new HlsPlaylistBuilder().segment(
            1,
            'tile.jpg\n#EXT-X-ENDLIST',
            'evil\r#EXT-X-DISCONTINUITY',
        );
        const lines = builder.getLines();
        expect(lines).toEqual([
            '#EXTINF:1.000000,evil#EXT-X-DISCONTINUITY',
            'tile.jpg#EXT-X-ENDLIST',
        ]);
    });

    it('segmentWithByteRange() strips CR/LF from uri', () => {
        const builder = new HlsPlaylistBuilder().segmentWithByteRange(
            1,
            'seg.ts\r\n#EXT-X-ENDLIST',
            100,
            0,
        );
        const lines = builder.getLines();
        expect(lines[lines.length - 1]).toBe('seg.ts#EXT-X-ENDLIST');
        expect(lines.some((l) => l.includes('\n') || l.includes('\r'))).toBe(false);
    });

    it('raw() strips CR/LF from the line', () => {
        const builder = new HlsPlaylistBuilder().raw('#EXT-X-CUSTOM:x\n#EXT-X-ENDLIST');
        expect(builder.getLines()).toEqual(['#EXT-X-CUSTOM:x#EXT-X-ENDLIST']);
    });

    it('build() never contains more physical lines than were pushed', () => {
        const builder = new HlsPlaylistBuilder()
            .header()
            .segment(1, 'a\n\n\nb', 'c\r\r\rd')
            .endlist();
        const body = builder.build();
        // header + EXTINF + uri + endlist = 4 lines (+ trailing '\n' from build())
        expect(body.split('\n').filter((l) => l.length > 0)).toHaveLength(4);
    });
});
