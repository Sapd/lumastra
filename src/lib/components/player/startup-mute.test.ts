// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { shouldPersistVolumeChange, startupMuted } from './startup-mute';

describe('startupMuted', () => {
    it('never starts muted on iOS, whatever was saved', () => {
        expect(startupMuted(true, true)).toBe(false);
        expect(startupMuted(false, true)).toBe(false);
    });

    it('keeps the saved mute elsewhere', () => {
        expect(startupMuted(true, false)).toBe(true);
        expect(startupMuted(false, false)).toBe(false);
    });
});

describe('shouldPersistVolumeChange', () => {
    it('does not save before the player is initialized', () => {
        expect(
            shouldPersistVolumeChange({
                isInitialized: false,
                muted: false,
                mutedByAutoplayFallback: false,
            }),
        ).toBe(false);
    });

    it("does not save the autoplay fallback's mute as the user's choice", () => {
        expect(
            shouldPersistVolumeChange({
                isInitialized: true,
                muted: true,
                mutedByAutoplayFallback: true,
            }),
        ).toBe(false);
    });

    it('saves a mute or unmute the user made', () => {
        expect(
            shouldPersistVolumeChange({
                isInitialized: true,
                muted: true,
                mutedByAutoplayFallback: false,
            }),
        ).toBe(true);
        expect(
            shouldPersistVolumeChange({
                isInitialized: true,
                muted: false,
                mutedByAutoplayFallback: true,
            }),
        ).toBe(true);
    });
});
