// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWarn = vi.hoisted(() => vi.fn());
vi.mock('./logger', () => ({
    Logger: { for: () => ({ warn: mockWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import {
    DISABLED_HEADER_LOG_INTERVAL_MS,
    getIgnoredForwardAuthSighting,
    noteIgnoredForwardAuthHeaders,
    resetIgnoredForwardAuthSighting,
    shouldLogUntrustedWhileDisabled,
} from './forward-auth-disabled-observer';

const T0 = 1_800_000_000_000;

function note(now: number, request?: object): void {
    noteIgnoredForwardAuthHeaders({
        peer: '10.0.0.5',
        path: '/',
        headerNames: ['X-Forwarded-User'],
        now,
        request,
    });
}

beforeEach(() => {
    mockWarn.mockClear();
    resetIgnoredForwardAuthSighting();
});

describe('forward-auth disabled observer', () => {
    it('logs once per window and again once the window has passed', () => {
        note(T0);
        note(T0 + 1000);
        note(T0 + DISABLED_HEADER_LOG_INTERVAL_MS - 1);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        note(T0 + DISABLED_HEADER_LOG_INTERVAL_MS);
        expect(mockWarn).toHaveBeenCalledTimes(2);
        expect(getIgnoredForwardAuthSighting()).toMatchObject({
            count: 4,
            firstSeenAt: T0,
            lastSeenAt: T0 + DISABLED_HEADER_LOG_INTERVAL_MS,
        });
    });

    it('reopens the window when the clock steps backwards', () => {
        note(T0);
        note(T0 - 60 * 60 * 1000);
        expect(mockWarn).toHaveBeenCalledTimes(2);
    });

    it('counts one request once, however many readers see it', () => {
        const request = {};
        note(T0, request);
        note(T0 + 1, request);
        note(T0 + 2, {});
        expect(getIgnoredForwardAuthSighting()?.count).toBe(2);
    });

    it('never logs header values, only names', () => {
        note(T0);
        expect(JSON.stringify(mockWarn.mock.calls[0])).toContain('X-Forwarded-User');
        expect(mockWarn.mock.calls[0][1]).not.toHaveProperty('value');
    });

    it('rate-limits the untrusted-peer log while forward auth is off, without a sighting', () => {
        expect(shouldLogUntrustedWhileDisabled(T0)).toBe(true);
        expect(shouldLogUntrustedWhileDisabled(T0 + 1000)).toBe(false);
        expect(shouldLogUntrustedWhileDisabled(T0 + DISABLED_HEADER_LOG_INTERVAL_MS)).toBe(true);
        expect(getIgnoredForwardAuthSighting()).toBeNull();
    });
});
