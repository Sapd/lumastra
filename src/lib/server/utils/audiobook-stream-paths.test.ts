// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The auth-bypass predicate for the audiobook byte proxy.
 *
 * This decides which `/api/v1` paths may run without the surface's normal
 * bearer gate, so an over-broad match is a privilege escalation, not a style
 * problem. The first implementation was `startsWith('/api/v1/audiobook/') &&
 * (includes('/file/') || includes('/hls/'))`, which let an attacker CHOOSE to
 * exempt an unrelated sibling route by naming a book `file` — the cases below
 * pin that shut.
 */

import { describe, it, expect } from 'vitest';
import { isAudiobookByteProxyPath, isRetiredAudiobookBytePath } from './audiobook-stream-paths.js';

describe('isAudiobookByteProxyPath', () => {
    it('matches the three byte sub-paths', () => {
        expect(
            isAudiobookByteProxyPath(
                '/api/v1/audiobooks/2b1f8e0e-0000-0000-0000-000000000001/files/1',
            ),
        ).toBe(true);
        expect(
            isAudiobookByteProxyPath(
                '/api/v1/audiobook/2b1f8e0e-0000-0000-0000-000000000001/hls/stream_abc/sess-1/output-4.ts',
            ),
        ).toBe(true);
        expect(
            isAudiobookByteProxyPath(
                '/api/v1/audiobooks/2b1f8e0e-0000-0000-0000-000000000001/remux/1',
            ),
        ).toBe(true);
    });

    it('does NOT match a sibling route reached with a mediaId of "file" or "hls"', () => {
        // The substring form returned true for all of these.
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/file/bookmarks')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/hls/anything')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/file/sessions/secret')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/remux/bookmarks')).toBe(false);
    });

    it('does not match other lengths of the same shape', () => {
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/M/file')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/M/file/5193/extra')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/M/hls/tok/sess')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/M/hls/tok/sess/out.ts/extra')).toBe(
            false,
        );
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/M/remux')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/M/remux/9001/extra')).toBe(false);
    });

    it('does not match a look-alike prefix on another surface or resource', () => {
        expect(isAudiobookByteProxyPath('/api/audiobook/M/file/5193')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/audiobooks/M/file/5193')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/admin/audiobook/M/file/5193')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/M/files/5193')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/M/remuxes/5193')).toBe(false);
    });

    it('does not match a trailing slash or empty segment', () => {
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/M/file/')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/audiobook//file/5193')).toBe(false);
        expect(isAudiobookByteProxyPath('/api/v1/audiobook/M/remux/')).toBe(false);
    });
});

it.each([
    '/api/audiobooks/book/files/1',
    '/api/v1/audiobook/book/file/1',
    '/api/v1/audiobook/book/remux/1',
])('retired or internal byte route %s stays outside the auth exemption', (path) => {
    expect(isAudiobookByteProxyPath(path)).toBe(false);
});

describe('isRetiredAudiobookBytePath', () => {
    it.each([
        '/api/v1/audiobook/M/file/5193',
        '/api/v1/audiobook/2b1f8e0e-0000-0000-0000-000000000001/remux/1',
    ])('matches the retired singular byte path %s', (path) => {
        expect(isRetiredAudiobookBytePath(path)).toBe(true);
    });

    it.each([
        '/api/v1/audiobook/M/hls/tok/sess/out.ts', // HLS family stays live
        '/api/v1/audiobook/M/file',
        '/api/v1/audiobook/M/file/5193/extra',
        '/api/v1/audiobooks/M/files/1', // the replacement is not retired
        '/api/v1/audiobook/file/bookmarks',
    ])('does not match %s', (path) => {
        expect(isRetiredAudiobookBytePath(path)).toBe(false);
    });
});
