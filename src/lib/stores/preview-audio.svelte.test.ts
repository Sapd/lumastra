// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from 'vitest';
import { nextPreviewAudioId, previewAudio } from './preview-audio.svelte';

describe('preview-audio exclusive ownership', () => {
    beforeEach(() => {
        // Reset ownership between tests (release whoever currently holds it).
        if (previewAudio.owner) previewAudio.release(previewAudio.owner);
    });

    it('mints unique, monotonic ids', () => {
        const a = nextPreviewAudioId('hero');
        const b = nextPreviewAudioId('hero');
        const c = nextPreviewAudioId('preview');
        expect(a).not.toBe(b);
        expect(b).not.toBe(c);
        expect(a.startsWith('hero-')).toBe(true);
        expect(c.startsWith('preview-')).toBe(true);
    });

    it('starts with no owner (everyone muted)', () => {
        expect(previewAudio.owner).toBeNull();
        expect(previewAudio.owns(nextPreviewAudioId())).toBe(false);
    });

    it('claiming transfers ownership away from the previous owner', () => {
        const hero = nextPreviewAudioId('hero');
        const preview = nextPreviewAudioId('preview');

        previewAudio.claim(hero);
        expect(previewAudio.owns(hero)).toBe(true);
        expect(previewAudio.owns(preview)).toBe(false);

        // Unmuting the preview claims audio and silences the hero.
        previewAudio.claim(preview);
        expect(previewAudio.owns(preview)).toBe(true);
        expect(previewAudio.owns(hero)).toBe(false);
    });

    it('release only clears ownership for the actual owner', () => {
        const hero = nextPreviewAudioId('hero');
        const preview = nextPreviewAudioId('preview');
        previewAudio.claim(hero);

        // A non-owner releasing is a no-op.
        previewAudio.release(preview);
        expect(previewAudio.owns(hero)).toBe(true);

        // The owner releasing leaves nobody with audio.
        previewAudio.release(hero);
        expect(previewAudio.owner).toBeNull();
    });

    it('models "only one audible player" across a realistic sequence', () => {
        const hero = nextPreviewAudioId('hero');
        const featured = nextPreviewAudioId('hero');
        const preview = nextPreviewAudioId('preview');
        const players = [hero, featured, preview];

        const audibleCount = () => players.filter((p) => previewAudio.owns(p)).length;

        expect(audibleCount()).toBe(0); // all muted on load
        previewAudio.claim(hero);
        expect(audibleCount()).toBe(1);
        previewAudio.claim(preview); // unmuting the preview silences the hero
        expect(audibleCount()).toBe(1);
        expect(previewAudio.owns(preview)).toBe(true);
        previewAudio.release(preview); // muting the last owner => silence
        expect(audibleCount()).toBe(0);
    });
});
