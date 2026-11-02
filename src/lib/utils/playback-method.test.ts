// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    toPlayMethod,
    toPlayMethodOrDefault,
    getPlayMethodShortLabel,
    getPlayMethodLabel,
    getPlayMethodBadgeClass,
} from './playback-method.js';

describe('toPlayMethod', () => {
    it('passes through canonical lowercase enum values', () => {
        expect(toPlayMethod('direct')).toBe('direct');
        expect(toPlayMethod('remux')).toBe('remux');
        expect(toPlayMethod('audio_transcode')).toBe('audio_transcode');
        expect(toPlayMethod('full_transcode')).toBe('full_transcode');
    });

    // The audio-only rung. Its absence here was silent data corruption rather
    // than a failure: `toPlayMethodOrDefault('audio_only')` returned `'direct'`,
    // so the play-sessions row for an audio-only stream said DIRECT PLAY.
    it('recognises audio_only in both canonical and player PascalCase form', () => {
        expect(toPlayMethod('audio_only')).toBe('audio_only');
        expect(toPlayMethod('AudioOnly')).toBe('audio_only');
        // The fallback path is the one that actually shipped the bad value.
        expect(toPlayMethodOrDefault('audio_only')).toBe('audio_only');
        expect(toPlayMethodOrDefault('AudioOnly')).toBe('audio_only');
    });

    it('coerces Jellyfin PascalCase to canonical', () => {
        expect(toPlayMethod('DirectPlay')).toBe('direct');
        expect(toPlayMethod('DirectStream')).toBe('remux');
        // Jellyfin's coarse 'Transcode' collapses onto full_transcode (safer
        // default — matches former mapPlayMethod in play-session-reporter).
        expect(toPlayMethod('Transcode')).toBe('full_transcode');
    });

    it('is case-insensitive', () => {
        expect(toPlayMethod('directplay')).toBe('direct');
        expect(toPlayMethod('DIRECTSTREAM')).toBe('remux');
        expect(toPlayMethod('TRANSCODE')).toBe('full_transcode');
    });

    it('returns null for empty / unknown input', () => {
        expect(toPlayMethod(null)).toBeNull();
        expect(toPlayMethod(undefined)).toBeNull();
        expect(toPlayMethod('')).toBeNull();
        expect(toPlayMethod('unknown')).toBeNull();
        expect(toPlayMethod('garbage')).toBeNull();
    });

    it('strips whitespace before matching', () => {
        expect(toPlayMethod('  direct  ')).toBe('direct');
        expect(toPlayMethod('\tDirectStream\n')).toBe('remux');
        expect(toPlayMethod('   ')).toBeNull();
    });
});

describe('toPlayMethodOrDefault', () => {
    it('falls back to direct for unknown / empty input', () => {
        expect(toPlayMethodOrDefault(null)).toBe('direct');
        expect(toPlayMethodOrDefault(undefined)).toBe('direct');
        expect(toPlayMethodOrDefault('')).toBe('direct');
        expect(toPlayMethodOrDefault('unknown')).toBe('direct');
    });

    it('preserves known canonical and Jellyfin values', () => {
        expect(toPlayMethodOrDefault('audio_transcode')).toBe('audio_transcode');
        expect(toPlayMethodOrDefault('Transcode')).toBe('full_transcode');
    });
});

describe('label helpers', () => {
    it('short labels stay terse for pill use', () => {
        expect(getPlayMethodShortLabel('direct')).toBe('Direct');
        expect(getPlayMethodShortLabel('remux')).toBe('Remux');
        expect(getPlayMethodShortLabel('audio_transcode')).toBe('Audio TC');
        expect(getPlayMethodShortLabel('full_transcode')).toBe('Transcode');
        expect(getPlayMethodShortLabel('audio_only')).toBe('Audio');
    });

    it('verbose labels match what tables/details should render', () => {
        expect(getPlayMethodLabel('direct')).toBe('Direct');
        expect(getPlayMethodLabel('remux')).toBe('Remux');
        expect(getPlayMethodLabel('audio_transcode')).toBe('Audio Transcode');
        expect(getPlayMethodLabel('full_transcode')).toBe('Transcode');
    });
});

describe('getPlayMethodBadgeClass', () => {
    it('coarsens audio/full transcode into a single badge class', () => {
        expect(getPlayMethodBadgeClass('direct')).toBe('badge-direct');
        expect(getPlayMethodBadgeClass('remux')).toBe('badge-remux');
        expect(getPlayMethodBadgeClass('audio_transcode')).toBe('badge-transcode');
        expect(getPlayMethodBadgeClass('full_transcode')).toBe('badge-transcode');
    });
});
