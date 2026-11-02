// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    deleteConfirmExpectedValue,
    isDeleteConfirmed,
    EMPTY_TITLE_DELETE_CONFIRM_WORD,
} from './delete-confirm.js';

describe('isDeleteConfirmed', () => {
    it('matches the exact title once typed', () => {
        expect(isDeleteConfirmed('The Wisp', 'The Wisp')).toBe(true);
        expect(isDeleteConfirmed('the wisp', 'The Wisp')).toBe(false);
    });

    it('does not confirm on an empty input against a normal title', () => {
        expect(isDeleteConfirmed('', 'The Wisp')).toBe(false);
    });

    it('trims whitespace around the typed input', () => {
        expect(isDeleteConfirmed('  The Wisp  ', 'The Wisp')).toBe(true);
    });

    it('does NOT auto-confirm on dialog open for an item with an empty raw title', () => {
        // Reverting to `input.trim() === rawTitle` reintroduces the bug:
        // ''.trim() === '' is true before the operator types anything, so
        // Delete would be enabled the instant the dialog opens on exactly
        // the items (title-less seasons) most likely to be deleted by
        // accident. This must stay false with nothing typed.
        expect(isDeleteConfirmed('', '')).toBe(false);
    });

    it('confirms an empty-title item only via the fixed fallback word', () => {
        expect(isDeleteConfirmed(EMPTY_TITLE_DELETE_CONFIRM_WORD, '')).toBe(true);
        expect(isDeleteConfirmed('delete', '')).toBe(false);
        expect(isDeleteConfirmed('Season 3', '')).toBe(false);
    });

    it('treats a whitespace-only raw title the same as empty', () => {
        expect(isDeleteConfirmed('', '   ')).toBe(false);
        expect(isDeleteConfirmed(EMPTY_TITLE_DELETE_CONFIRM_WORD, '   ')).toBe(true);
    });
});

describe('deleteConfirmExpectedValue', () => {
    it('returns the trimmed title when one exists', () => {
        expect(deleteConfirmExpectedValue('  The Wisp  ')).toBe('The Wisp');
    });

    it('falls back to the fixed word when the raw title is empty', () => {
        expect(deleteConfirmExpectedValue('')).toBe(EMPTY_TITLE_DELETE_CONFIRM_WORD);
    });
});
