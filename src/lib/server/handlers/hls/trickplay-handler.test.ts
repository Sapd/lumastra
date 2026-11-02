// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * handleTrickplayPlaylist built the tile URI by string-concatenating raw
 * query values (via buildAuthQueryFragment's unescaped template + a bare
 * `fileId=${fileId}`) directly into an HLS playlist line. A `fileId` or
 * `grant` containing a literal CR/LF (delivered percent-encoded over
 * HTTP, e.g. `%0A%23EXT-X-ENDLIST`) split the single playlist line into
 * multiple lines, letting the query value inject arbitrary extra HLS tags —
 * a CRLF/playlist-injection primitive. The fix builds the tile query with
 * URLSearchParams (which percent-encodes values), matching the sibling
 * iframe-handler / subtitle-handler builders.
 */

import { describe, it, expect } from 'vitest';
import { handleTrickplayPlaylist } from './trickplay-handler.js';

const ITEM_ID = 'item-1';

describe('handleTrickplayPlaylist CRLF injection', () => {
    it('percent-encodes a fileId/grant containing CRLF instead of splitting the playlist', async () => {
        const maliciousFileId = 'x\n#EXT-X-ENDLIST';
        const maliciousToken = 'a\rb';

        const url = new URL(
            `http://localhost/api/v1/playback/${ITEM_ID}/hls/trickplay.m3u8` +
                `?trickplay_width=100&trickplay_interval=1000&trickplay_count=1` +
                `&trickplay_tile_width=1&trickplay_tile_height=1` +
                `&fileId=${encodeURIComponent(maliciousFileId)}` +
                `&grant=${encodeURIComponent(maliciousToken)}`,
        );

        const res = await handleTrickplayPlaylist(ITEM_ID, url);
        expect(res.status).toBe(200);

        const body = await res.text();
        const lines = body.split('\n').filter((l) => l.length > 0);

        // Exactly: #EXTM3U, #EXT-X-IMAGES-ONLY, #EXT-X-TARGETDURATION, #EXT-X-PLAYLIST-TYPE,
        // #EXT-X-TILES, #EXTINF, <uri>, #EXT-X-ENDLIST — one sheet, no injected extra lines.
        expect(lines).toHaveLength(8);
        expect(lines[0]).toBe('#EXTM3U');
        expect(lines[lines.length - 1]).toBe('#EXT-X-ENDLIST');

        // Only the trailing line is the real ENDLIST tag — no injected copy mid-playlist.
        const endlistLines = lines.filter((l) => l === '#EXT-X-ENDLIST');
        expect(endlistLines).toHaveLength(1);

        // The tile URI line carries the raw newline/CR percent-encoded, not literal.
        const uriLine = lines[6];
        expect(uriLine).not.toMatch(/[\r\n]/);
        expect(uriLine).toContain('fileId=x%0A%23EXT-X-ENDLIST');
        expect(uriLine).toContain('grant=a%0Db');
    });
});
