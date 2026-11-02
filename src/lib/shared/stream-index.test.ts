// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for stream-index conversions.
 *
 * The recurring "wrong audio language" bug came from confusing the absolute
 * ffmpeg stream index (1, 2 for audio in a 1-video/2-audio file) with the
 * 0-based audio-relative index (0, 1). These tests pin the conversions for the
 * exact layouts that broke in the wild.
 */

import { describe, it, expect } from 'vitest';
import {
    asAbsoluteStreamIndex,
    audioRelativeToAbsolute,
    absoluteToAudioRelative,
    resolveAudioTrackByAbsoluteIndex,
    defaultAudioAbsoluteIndex,
} from './stream-index';

// Real-world layout that broke: video@0, German@abs1 (default), English@abs2.
const RICK_AND_MORTY = [
    { audioRelativeIndex: 0, absoluteIndex: 1 }, // German (default)
    { audioRelativeIndex: 1, absoluteIndex: 2 }, // English
];

// Harder layout: a subtitle precedes the audio, so audio does NOT start at abs 1.
// video@0, subtitle@abs1, German@abs2, English@abs3.
const SUBS_BEFORE_AUDIO = [
    { audioRelativeIndex: 0, absoluteIndex: 2 }, // German
    { audioRelativeIndex: 1, absoluteIndex: 3 }, // English
];

describe('audioRelativeToAbsolute', () => {
    it('maps the 2nd audio track (relative 1) to its absolute index', () => {
        expect(audioRelativeToAbsolute(RICK_AND_MORTY, 1)).toBe(2); // English
        expect(audioRelativeToAbsolute(RICK_AND_MORTY, 0)).toBe(1); // German
    });

    it('handles layouts where audio does not start at absolute index 1', () => {
        expect(audioRelativeToAbsolute(SUBS_BEFORE_AUDIO, 1)).toBe(3); // English
        expect(audioRelativeToAbsolute(SUBS_BEFORE_AUDIO, 0)).toBe(2); // German
    });

    it('returns undefined for a non-existent audio-relative index', () => {
        expect(audioRelativeToAbsolute(RICK_AND_MORTY, 5)).toBeUndefined();
    });
});

describe('absoluteToAudioRelative', () => {
    it('maps an absolute index back to its audio-relative index', () => {
        expect(absoluteToAudioRelative(RICK_AND_MORTY, 2)).toBe(1); // English
        expect(absoluteToAudioRelative(SUBS_BEFORE_AUDIO, 2)).toBe(0); // German
    });

    it('returns undefined when the absolute index is not an audio stream', () => {
        expect(absoluteToAudioRelative(RICK_AND_MORTY, 0)).toBeUndefined(); // video
    });
});

describe('resolveAudioTrackByAbsoluteIndex', () => {
    // The server AudioTrackInfo carries the ABSOLUTE index in `.index`.
    const SERVER_TRACKS = [
        { index: asAbsoluteStreamIndex(1), language: 'ger' }, // German (default), array position 0
        { index: asAbsoluteStreamIndex(2), language: 'eng' }, // English, array position 1
    ];

    it('resolves English (absolute 2) to array position 1 — the original bug', () => {
        const result = resolveAudioTrackByAbsoluteIndex(SERVER_TRACKS, asAbsoluteStreamIndex(2));
        expect(result.matched).toBe(true);
        expect(result.position).toBe(1);
        expect(result.track?.language).toBe('eng');
    });

    it('resolves German (absolute 1) to array position 0', () => {
        const result = resolveAudioTrackByAbsoluteIndex(SERVER_TRACKS, asAbsoluteStreamIndex(1));
        expect(result.matched).toBe(true);
        expect(result.position).toBe(0);
        expect(result.track?.language).toBe('ger');
    });

    it('resolves correctly when audio does not start at absolute 1', () => {
        const tracks = [
            { index: asAbsoluteStreamIndex(2), language: 'ger' },
            { index: asAbsoluteStreamIndex(3), language: 'eng' },
        ];
        const result = resolveAudioTrackByAbsoluteIndex(tracks, asAbsoluteStreamIndex(3));
        expect(result.position).toBe(1);
        expect(result.track?.language).toBe('eng');
    });

    it('falls back to the first track (position 0, matched=false) on no match', () => {
        const result = resolveAudioTrackByAbsoluteIndex(SERVER_TRACKS, asAbsoluteStreamIndex(99));
        expect(result.matched).toBe(false);
        expect(result.position).toBe(0);
        expect(result.track?.language).toBe('ger');
    });

    it('regression: selecting English must NOT resolve to German', () => {
        // The bug: a 0-based position (1) was treated as an absolute index, and
        // findIndex(t.index === 1) matched German (abs 1). Now we pass the true
        // absolute index (2) and get English.
        const result = resolveAudioTrackByAbsoluteIndex(SERVER_TRACKS, asAbsoluteStreamIndex(2));
        expect(result.track?.language).not.toBe('ger');
        expect(result.track?.language).toBe('eng');
    });
});

describe('defaultAudioAbsoluteIndex', () => {
    it("returns the isDefault track's absolute index, not container order", () => {
        // English first in the container but NOT the default; German is.
        const tracks = [
            { index: asAbsoluteStreamIndex(1), isDefault: false, language: 'eng' },
            { index: asAbsoluteStreamIndex(2), isDefault: true, language: 'ger' },
        ];
        expect(defaultAudioAbsoluteIndex(tracks)).toBe(2);
    });

    it('falls back to the first track when nothing is flagged default', () => {
        const tracks = [
            { index: asAbsoluteStreamIndex(1), isDefault: false, language: 'eng' },
            { index: asAbsoluteStreamIndex(2), isDefault: false, language: 'ger' },
        ];
        expect(defaultAudioAbsoluteIndex(tracks)).toBe(1);
    });

    it('tolerates a missing isDefault flag', () => {
        expect(
            defaultAudioAbsoluteIndex([
                { index: asAbsoluteStreamIndex(3) },
                { index: asAbsoluteStreamIndex(4) },
            ]),
        ).toBe(3);
    });

    it('returns 0 for an empty track list', () => {
        // Nothing to select. resolveAudioTrackByAbsoluteIndex will return an
        // undefined track for this, and the caller maps no audio at all.
        expect(defaultAudioAbsoluteIndex([])).toBe(0);
    });

    it('never returns absolute 0 for a normal file — that is the video stream', () => {
        // The whole point of D12: the old `?? 0` fallback asked for absolute 0,
        // which is the VIDEO stream on essentially every file, so it never
        // matched and silently fell through to container order.
        const tracks = [
            { index: asAbsoluteStreamIndex(1), isDefault: false },
            { index: asAbsoluteStreamIndex(2), isDefault: true },
        ];
        expect(defaultAudioAbsoluteIndex(tracks)).not.toBe(0);
    });
});
