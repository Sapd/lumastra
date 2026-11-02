// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { tmdbTransportCodes } from './transport-errors.js';

describe('TMDB transport diagnostics', () => {
    it('extracts DNS errors from native fetch wrapping', () => {
        const cause = Object.assign(new Error('sensitive URL'), { code: 'EAI_AGAIN' });
        expect(tmdbTransportCodes(new TypeError('fetch failed', { cause }))).toEqual(['EAI_AGAIN']);
    });
    it('retains both address-family failures from an aggregate connect error', () => {
        const cause = new AggregateError([
            { code: 'ENETUNREACH' },
            { code: 'ETIMEDOUT' },
            { code: 'ETIMEDOUT' },
        ]);
        expect(tmdbTransportCodes(new TypeError('fetch failed', { cause }))).toEqual([
            'ENETUNREACH',
            'ETIMEDOUT',
        ]);
    });
    it('never exposes messages, URLs, headers or arbitrary codes', () => {
        const error = {
            code: 'secret-api-key',
            message: 'secret',
            url: 'https://secret',
            headers: { Authorization: 'secret' },
            cause: { code: 'CERT_HAS_EXPIRED' },
        };
        expect(tmdbTransportCodes(error)).toEqual(['CERT_HAS_EXPIRED']);
    });
    it('bounds cycles and handles non-errors', () => {
        const error: { cause?: unknown; code: string } = { code: 'ECONNRESET' };
        error.cause = error;
        expect(tmdbTransportCodes(error)).toEqual(['ECONNRESET']);
        expect(tmdbTransportCodes(null)).toEqual([]);
        expect(tmdbTransportCodes('fetch failed')).toEqual([]);
    });
});
