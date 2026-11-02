// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { formatApiError } from './api-error-format.js';

describe('formatApiError', () => {
    it('appends field-level validation details to the message', () => {
        const out = formatApiError('Request validation failed', [
            {
                field: 'body.max_concurrent_streams',
                message: 'Too big: expected number to be <=20',
            },
        ]);

        expect(out).toBe(
            'Request validation failed — max concurrent streams: Too big: expected number to be <=20',
        );
    });

    it('joins multiple details', () => {
        const out = formatApiError('Request validation failed', [
            { field: 'body.max_concurrent_streams', message: 'Too big' },
            { field: 'body.ip_grace_period_seconds', message: 'Too small' },
        ]);

        expect(out).toBe(
            'Request validation failed — max concurrent streams: Too big; ip grace period seconds: Too small',
        );
    });

    it('returns the bare message when there are no details', () => {
        expect(formatApiError('Something broke', undefined)).toBe('Something broke');
        expect(formatApiError('Something broke', [])).toBe('Something broke');
    });

    it('ignores detail payloads that are not ValidationDetail[] (quota objects, strings)', () => {
        expect(formatApiError('Quota exceeded', { bucket: 'chat', limit: 10 })).toBe(
            'Quota exceeded',
        );
        expect(formatApiError('Nope', 'some string')).toBe('Nope');
    });

    it('skips malformed entries but keeps well-formed ones', () => {
        const out = formatApiError('Bad', [
            { nope: true },
            { field: 'body.x', message: 'is required' },
        ]);

        expect(out).toBe('Bad — x: is required');
    });

    it('falls back to the raw field when it carries no dotted prefix', () => {
        expect(formatApiError('Bad', [{ field: 'limit', message: 'Must be > 0' }])).toBe(
            'Bad — limit: Must be > 0',
        );
    });
});
