// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isPlaylistClassContainer } from './playlist-container';

describe('isPlaylistClassContainer', () => {
    it('returns true for the hls demuxer name', () => {
        expect(isPlaylistClassContainer('hls')).toBe(true);
    });

    it('returns true for the dash demuxer name', () => {
        expect(isPlaylistClassContainer('dash')).toBe(true);
    });

    it('returns true for the concat demuxer name', () => {
        expect(isPlaylistClassContainer('concat')).toBe(true);
    });

    it('returns true for the imf demuxer name', () => {
        expect(isPlaylistClassContainer('imf')).toBe(true);
    });

    it('matches case-insensitively and inside a comma-separated alias list', () => {
        expect(isPlaylistClassContainer('HLS')).toBe(true);
        expect(isPlaylistClassContainer('foo,concat,bar')).toBe(true);
    });

    // Controls: real media containers must never be caught by this gate.
    it('returns false for a real movie container', () => {
        expect(isPlaylistClassContainer('mov,mp4,m4a,3gp,3g2,mj2')).toBe(false);
    });

    it('returns false for a real matroska container', () => {
        expect(isPlaylistClassContainer('matroska,webm')).toBe(false);
    });

    it('returns false for mpegts (a real transport-stream container, not the hls demuxer)', () => {
        expect(isPlaylistClassContainer('mpegts')).toBe(false);
    });

    it('returns false for null/undefined', () => {
        expect(isPlaylistClassContainer(null)).toBe(false);
        expect(isPlaylistClassContainer(undefined)).toBe(false);
    });
});
