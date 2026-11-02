// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { classifyError } from './error-contract';

describe('classifyError', () => {
    it('CRITICAL INVARIANT: a failed fetch never classifies as auth (spec §7)', () => {
        // This app's API client reports status 0 for network/timeout failures
        // (`$lib/api/client.ts`) — never a real 401/403. A network failure must
        // never render "session expired".
        const result = classifyError(new TypeError('Failed to fetch'), { status: 0 });
        expect(result.class).not.toBe('auth');
        expect(result.class).toBe('network');
    });

    it('classifies status 0 (no response) as network even without a network-shaped err', () => {
        const result = classifyError(new Error('some generic error'), { status: 0 });
        expect(result.class).toBe('network');
        expect(result.retryable).toBe(true);
    });

    it('classifies a TypeError with no response as network (raw fetch failure)', () => {
        const result = classifyError(new TypeError('Failed to fetch'), null);
        expect(result.class).toBe('network');
    });

    it('classifies an AbortError as network', () => {
        const result = classifyError(new DOMException('aborted', 'AbortError'), null);
        expect(result.class).toBe('network');
    });

    it('classifies a real 401 as auth (not retryable)', () => {
        const result = classifyError(new Error('unauthorized'), { status: 401 });
        expect(result.class).toBe('auth');
        expect(result.retryable).toBe(false);
    });

    it('classifies a real 403 as auth', () => {
        const result = classifyError(new Error('forbidden'), { status: 403 });
        expect(result.class).toBe('auth');
    });

    it('classifies 5xx as server (retryable)', () => {
        const result = classifyError(new Error('boom'), { status: 503 });
        expect(result.class).toBe('server');
        expect(result.retryable).toBe(true);
    });

    it('classifies other 4xx as data (not retryable)', () => {
        const result = classifyError(new Error('bad request'), { status: 400 });
        expect(result.class).toBe('data');
        expect(result.retryable).toBe(false);
    });

    it('classifies a JSON parse failure as data', () => {
        const result = classifyError(new SyntaxError('Unexpected token'), null);
        expect(result.class).toBe('data');
    });

    it('classifies a ZodError-shaped error as data', () => {
        const err = new Error('invalid');
        err.name = 'ZodError';
        const result = classifyError(err, null);
        expect(result.class).toBe('data');
    });

    it('defaults an unrecognized error with no response to server', () => {
        const result = classifyError({ weird: 'shape' }, null);
        expect(result.class).toBe('server');
    });

    it('carries the raw error text in `detail`, not in the operator-facing `message`', () => {
        const result = classifyError(new Error('ECONNREFUSED 10.0.0.1:5432'), { status: 0 });
        expect(result.detail).toContain('ECONNREFUSED');
        expect(result.message).not.toContain('ECONNREFUSED');
    });
});
