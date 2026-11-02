// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Terminal-vs-transient classification for per-user AudiobookShelf failures.
 *
 * Getting this wrong is not a crash, it is a stall: a misclassified terminal
 * failure is retried ahead of every newer item in the push queue on every
 * cycle, forever (the head-of-line block `drainedAsSkipped` exists to prevent).
 */

import { describe, it, expect } from 'vitest';
import { AudiobookshelfUserAuthError } from './audiobookshelf.js';

describe('AudiobookshelfUserAuthError', () => {
    it('treats a rejected credential as terminal AND credential-rejected', () => {
        for (const status of [401, 403]) {
            const err = new AudiobookshelfUserAuthError(status);
            expect(err.terminal).toBe(true);
            expect(err.credentialRejected).toBe(true);
        }
    });

    it('treats a vanished item as terminal but NOT credential-rejected', () => {
        // A 404 must drain (the item is gone upstream) without also nuking the
        // user's key — clearing credentials on a missing item would unlink a
        // perfectly healthy account.
        for (const status of [404, 410]) {
            const err = new AudiobookshelfUserAuthError(status);
            expect(err.terminal).toBe(true);
            expect(err.credentialRejected).toBe(false);
        }
    });

    it('treats server errors and rate limits as transient', () => {
        for (const status of [429, 500, 502, 503]) {
            const err = new AudiobookshelfUserAuthError(status);
            expect(err.terminal).toBe(false);
            expect(err.credentialRejected).toBe(false);
        }
    });

    it('names the failing operation in the message', () => {
        const err = new AudiobookshelfUserAuthError(404, 'PATCH /api/me/progress/abc');
        expect(err.message).toContain('PATCH /api/me/progress/abc');
        expect(err.message).toContain('404');
    });
});
