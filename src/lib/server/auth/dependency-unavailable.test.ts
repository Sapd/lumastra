// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { authUnavailableResponse, isDependencyError } from './dependency-unavailable.js';

describe('authentication unavailability response', () => {
    it('only permits mutation replay when the route handler has not run', () => {
        expect(authUnavailableResponse().headers.get('X-Lumastra-Auth-Unavailable')).toBe('true');
        expect(authUnavailableResponse().headers.has('X-Lumastra-Auth-Retry')).toBe(false);
        expect(
            authUnavailableResponse({ beforeHandler: true }).headers.get(
                'X-Lumastra-Auth-Unavailable',
            ),
        ).toBe('true');
        expect(
            authUnavailableResponse({ beforeHandler: true }).headers.get('X-Lumastra-Auth-Retry'),
        ).toBe('true');
    });
});

describe('dependency error classification', () => {
    it.each([
        'CONNECTION_CLOSED',
        'CONNECTION_ENDED',
        'CONNECT_TIMEOUT',
        '08006',
        '53300',
        '57P01',
        '57P03',
        '25006',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ECONNRESET',
        'EPIPE',
    ])('recognizes %s', (code) => {
        expect(isDependencyError(Object.assign(new Error('failed'), { code }))).toBe(true);
    });
    it.each(['ConnectionError', 'ClosingError'])('recognizes Valkey %s', (name) => {
        expect(isDependencyError(Object.assign(new Error('Valkey unavailable'), { name }))).toBe(
            true,
        );
    });
    it('recognizes wrapped connection failures', () => {
        expect(
            isDependencyError(
                new Error('query failed', {
                    cause: Object.assign(new Error(), { code: 'ECONNRESET' }),
                }),
            ),
        ).toBe(true);
    });
    it.each([
        new TypeError('bad configuration'),
        new SyntaxError('bad JSON'),
        Object.assign(new Error('bad query'), { code: '42601' }),
        new Error('connection refused'),
    ])('does not classify unrelated errors as an outage: %s', (error) => {
        expect(isDependencyError(error)).toBe(false);
    });
});

it.each([
    'LOADING Redis is loading the dataset in memory',
    'READONLY You cannot write against a read only replica.',
    'BUSY Redis is busy running a script.',
])('recognizes Valkey failover RequestError %s', (message) => {
    expect(isDependencyError(Object.assign(new Error(message), { name: 'RequestError' }))).toBe(
        true,
    );
});
it('recognizes a Valkey client timeout, but not an outbound fetch TimeoutError', async () => {
    const { TimeoutError } = await import('@valkey/valkey-glide');
    expect(isDependencyError(new TimeoutError('Request timed out'))).toBe(true);
    expect(isDependencyError(new DOMException('The operation timed out', 'TimeoutError'))).toBe(
        false,
    );
    expect(
        isDependencyError(Object.assign(new Error('unrelated timeout'), { name: 'TimeoutError' })),
    ).toBe(false);
});
it('does not classify arbitrary RequestErrors as outages', () => {
    expect(
        isDependencyError(
            Object.assign(
                new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
                { name: 'RequestError' },
            ),
        ),
    ).toBe(false);
});
