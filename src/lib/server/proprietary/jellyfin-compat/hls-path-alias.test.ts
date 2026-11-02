// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, expect, it } from 'vitest';
import {
    aliasJellyfinHlsPath,
    hls1SegmentPath,
    normalizePlaySessionIdParam,
} from './hls-path-alias';

describe('aliasJellyfinHlsPath', () => {
    it.each([
        // Our own layout passes through.
        ['master.m3u8', 'master.m3u8'],
        ['segment_00003.ts', 'segment_00003.ts'],
        ['init_0.mp4', 'init_0.mp4'],
        ['stream_0/index.m3u8', 'stream_0/index.m3u8'],
        ['stream_0/segment_00001.m4s', 'stream_0/segment_00001.m4s'],
        ['stream_Ger_-_DD_51/index.m3u8', 'stream_Ger_-_DD_51/index.m3u8'],
        ['subs_1/seg_00002.vtt', 'subs_1/seg_00002.vtt'],
        ['iframe_00004.ts', 'iframe_00004.ts'],
        // Jellyfin's legacy playlist and segment names.
        ['0f3c/stream.m3u8', 'master.m3u8'],
        ['0f3c/STREAM.M3U8', 'master.m3u8'],
        ['0f3c/0f3c12.ts', 'segment_00012.ts'],
        ['0F3C/0f3c12.ts', 'segment_00012.ts'],
        ['0f3c/0f3c7.mp4', 'segment_00007.m4s'],
        // Our relative URIs resolved below the playlist id.
        ['0f3c/segment_00002.ts', 'segment_00002.ts'],
        ['0f3c/init_0.mp4', 'init_0.mp4'],
        // Not ours, not Jellyfin's: handed on (the handler 404s it).
        ['0f3c/other.ts', 'other.ts'],
        ['a/b/c.ts', 'a/b/c.ts'],
    ])('%s -> %s', (input, expected) => {
        expect(aliasJellyfinHlsPath(input)).toBe(expected);
    });

    it('never produces a traversal out of a two-part path', () => {
        expect(aliasJellyfinHlsPath('x/..')).toBe('..');
        // The segment handler rejects `..` itself (400); the alias adds no new form.
        expect(aliasJellyfinHlsPath('..%2F/stream.m3u8')).toBe('master.m3u8');
    });
});

describe('hls1SegmentPath', () => {
    it.each([
        ['0.ts', 'segment_00000.ts'],
        ['12.ts', 'segment_00012.ts'],
        ['12.TS', 'segment_00012.ts'],
        ['3.mp4', 'segment_00003.m4s'],
        ['3.m4s', 'segment_00003.m4s'],
        ['-1.mp4', 'init_0.mp4'],
        ['999999.ts', 'segment_999999.ts'],
    ])('%s -> %s', (input, expected) => {
        expect(hls1SegmentPath(input)).toBe(expected);
    });

    it.each(['-1.ts', '-2.mp4', '1000000.ts', 'abc.ts', '1.mkv', '1', '../1.ts', '1.ts/x'])(
        'rejects %s',
        (input) => {
            expect(hls1SegmentPath(input)).toBeNull();
        },
    );
});

describe('normalizePlaySessionIdParam', () => {
    it('copies playSessionId onto PlaySessionId', () => {
        const url = new URL('https://x.test/a?playSessionId=abc');
        normalizePlaySessionIdParam(url);
        expect(url.searchParams.get('PlaySessionId')).toBe('abc');
    });

    it('keeps an existing PlaySessionId', () => {
        const url = new URL('https://x.test/a?PlaySessionId=one&playsessionid=two');
        normalizePlaySessionIdParam(url);
        expect(url.searchParams.getAll('PlaySessionId')).toEqual(['one']);
    });

    it('does nothing without one', () => {
        const url = new URL('https://x.test/a?api_key=k');
        normalizePlaySessionIdParam(url);
        expect(url.searchParams.has('PlaySessionId')).toBe(false);
    });
});
