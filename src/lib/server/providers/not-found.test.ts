// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isProviderNotFoundError } from './not-found.js';
import { TmdbApiError } from './implementations/tmdb/client.js';

describe('isProviderNotFoundError', () => {
    it('recognizes typed 404/410 statuses', () => {
        expect(isProviderNotFoundError(new TmdbApiError('gone', { status: 404 }))).toBe(true);
        expect(isProviderNotFoundError(Object.assign(new Error('x'), { status: 410 }))).toBe(true);
    });

    it('recognizes the legacy plugin-provider 404 message', () => {
        expect(
            isProviderNotFoundError(
                new Error('TMDB API request failed: 404 Not Found — /movie/1754069'),
            ),
        ).toBe(true);
    });

    it('rejects 429, 5xx, timeouts and non-errors', () => {
        expect(isProviderNotFoundError(new TmdbApiError('x', { status: 429 }))).toBe(false);
        expect(isProviderNotFoundError(new TmdbApiError('x', { status: 500 }))).toBe(false);
        expect(isProviderNotFoundError(new Error('TMDB API request failed: 500 — /movie/1'))).toBe(
            false,
        );
        expect(isProviderNotFoundError(new Error('The operation was aborted (timeout)'))).toBe(
            false,
        );
        expect(isProviderNotFoundError(new TmdbApiError('net', { status: null }))).toBe(false);
        expect(isProviderNotFoundError(undefined)).toBe(false);
    });

    it('does not match a 404 mentioned mid-message (typed status wins)', () => {
        expect(
            isProviderNotFoundError(Object.assign(new Error('proxy said 404'), { status: 502 })),
        ).toBe(false);
    });
});
