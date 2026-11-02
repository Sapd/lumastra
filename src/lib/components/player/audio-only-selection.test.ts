// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { selectAudioOnlyMethod, revertAudioOnlyForParty } from './audio-only-selection';
import { ORIGINAL_PROFILE } from '$lib/types/playback';

const info = (audioOnlyAvailable: boolean) =>
    ({
        activeVersion: { availableMethods: audioOnlyAvailable ? ['audio_only'] : [] },
    }) as never;

describe('selectAudioOnlyMethod', () => {
    it('defers when the user has not chosen audio-only', () => {
        expect(selectAudioOnlyMethod(info(true), 'original')).toBe('not-applicable');
    });
    it('selects audio_only when chosen and available', () => {
        expect(selectAudioOnlyMethod(info(true), 'audio-only')).toBe('audio_only');
    });
    it('returns null when chosen but unavailable', () => {
        expect(selectAudioOnlyMethod(info(false), 'audio-only')).toBeNull();
    });
});

describe('revertAudioOnlyForParty', () => {
    it('returns the previous profile when audio-only is active', () => {
        expect(revertAudioOnlyForParty('audio-only', ORIGINAL_PROFILE)).toBe(ORIGINAL_PROFILE);
    });
    it('falls back to Original when nothing was stashed', () => {
        expect(revertAudioOnlyForParty('audio-only', null)?.mode).toBe('original');
    });
    it('does nothing when not in audio-only', () => {
        expect(revertAudioOnlyForParty('fixed', ORIGINAL_PROFILE)).toBeNull();
    });
});
