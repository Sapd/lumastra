// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { applyStreamTokenToPlaybackUrl } from './stream-token-url';

describe('ready playback delivery hrefs', () => {
    it.each([
        '/api/v1/playback/abc/file?grant=stream_xyz',
        '/api/v1/playback/abc/hls?grant=stream_xyz&PlaySessionId=abc',
        '/api/v1/playback/abc/subtitles/2?grant=stream_xyz',
        '/api/v1/playback/abc/hls?grant=a%2Bb%2Fc#fragment',
        'https://cdn.example.com/x.m3u8',
        '/api/v1/music/tracks/a/stream?grant=stream_a',
        '/api/v1/audiobooks/a/files/1?grant=stream_book',
        '',
    ])('preserves the exact server href: %s', (href) => {
        expect(applyStreamTokenToPlaybackUrl(href)).toBe(href);
    });
    it('never substitutes a different credential into a ready href', () => {
        const href = '/api/v1/playback/item/file?grant=server';
        expect(applyStreamTokenToPlaybackUrl(href, 'other')).toBe(href);
    });
});
