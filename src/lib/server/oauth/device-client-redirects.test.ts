// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins `getRegisteredDeviceRedirect()` — the closed, server-only table that
 * stands between an UNAUTHENTICATED `POST /oauth/device` request's
 * self-declared `client_id` and the redirect target stored on the device
 * code row. See device-client-redirects.ts's module doc.
 */

import { describe, it, expect } from 'vitest';
import { getRegisteredDeviceRedirect } from './device-client-redirects.js';

describe('getRegisteredDeviceRedirect', () => {
    it('resolves the registered iOS app redirect', () => {
        expect(getRegisteredDeviceRedirect('lumastra-ios')).toBe('lumastra://');
    });

    it('does not resolve tvOS — its approving device is normally a different physical device', () => {
        expect(getRegisteredDeviceRedirect('lumastra-tvos')).toBeUndefined();
    });

    it('does not resolve the old pre-split shared client_id either (retired, never re-added)', () => {
        expect(getRegisteredDeviceRedirect('stellar-tvos')).toBeUndefined();
    });

    describe('unrecognized client_id — always undefined, never a throw or a guess', () => {
        it.each(['', 'unknown-client', 'lumastra-android', 'a'.repeat(5000)])(
            '%p resolves to undefined',
            (input) => {
                expect(getRegisteredDeviceRedirect(input)).toBeUndefined();
            },
        );
    });

    describe('prototype-pollution resistance — Object.prototype member names never throw or leak', () => {
        // Same class of bug device-scope-map.ts guards against: indexing a
        // plain object with an attacker-controlled key resolves through
        // Object.prototype for these names, returning a truthy non-string
        // value instead of undefined. A Map has no prototype chain to leak
        // through — these names must behave exactly like any other
        // unrecognized client_id.
        it.each([
            'constructor',
            'toString',
            'valueOf',
            'hasOwnProperty',
            '__proto__',
            'isPrototypeOf',
            'toLocaleString',
        ])('%p returns undefined and does not throw', (input) => {
            expect(() => getRegisteredDeviceRedirect(input)).not.toThrow();
            expect(getRegisteredDeviceRedirect(input)).toBeUndefined();
        });
    });

    it('never resolves to a value that is not exactly one of the table rows (structural closure)', () => {
        const candidates = [
            'lumastra-ios',
            'lumastra-tvos',
            'stellar-tvos',
            'garbage',
            '',
            'lumastra-ios ',
        ];
        for (const candidate of candidates) {
            const result = getRegisteredDeviceRedirect(candidate);
            if (result !== undefined) {
                expect(result).toBe('lumastra://');
            }
        }
    });
});
