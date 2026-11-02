// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins `mapRequestedScopeToRaw()` — the closed allowlist that stands between
 * an UNAUTHENTICATED `POST /oauth/device` request and the raw scopes fed to
 * `buildPrincipal()`. See device-scope-map.ts's module doc.
 */

import { describe, it, expect } from 'vitest';
import { mapRequestedScopeToRaw, KNOWN_DEVICE_REQUEST_SCOPES } from './device-scope-map.js';

describe('mapRequestedScopeToRaw', () => {
    it('maps "media" to the full read/write grant', () => {
        expect(mapRequestedScopeToRaw('media')).toEqual(['read', 'write']);
    });

    it('maps "media:read" to a read-only grant', () => {
        expect(mapRequestedScopeToRaw('media:read')).toEqual(['read']);
    });

    describe('backward compatibility — absent/unrecognized scope always falls back to the full grant', () => {
        it.each([undefined, null, '', '   '])('%p -> full grant', (input) => {
            expect(mapRequestedScopeToRaw(input)).toEqual(['read', 'write']);
        });

        it('an unrecognized string falls back to the full grant, never a rejection', () => {
            expect(mapRequestedScopeToRaw('anything-else')).toEqual(['read', 'write']);
        });
    });

    describe('privilege-escalation resistance — the literal requested string is never echoed as a scope', () => {
        it.each(['admin', 'tasks:admin', 'users:admin', 'access:admin', 'tokens:admin'])(
            '%p never reaches the raw scopes returned — falls back to the full grant instead',
            (input) => {
                const result = mapRequestedScopeToRaw(input);
                expect(result).toEqual(['read', 'write']);
                expect(result).not.toContain('admin');
                expect(result).not.toContain(input);
            },
        );

        it('a multi-token or trailing-garbage string is not partially matched', () => {
            expect(mapRequestedScopeToRaw('media write')).toEqual(['read', 'write']);
            expect(mapRequestedScopeToRaw('media:read extra')).toEqual(['read', 'write']);
        });

        it('a pathologically long string (would exceed the /oauth/device length cap, but the function must not assume that) falls back safely', () => {
            expect(mapRequestedScopeToRaw('m'.repeat(5000))).toEqual(['read', 'write']);
        });
    });

    describe('exact-match, trim-only semantics', () => {
        it('trims surrounding whitespace', () => {
            expect(mapRequestedScopeToRaw('  media  ')).toEqual(['read', 'write']);
            expect(mapRequestedScopeToRaw('  media:read  ')).toEqual(['read']);
        });

        it('is case-sensitive — "MEDIA" and "Media" are unrecognized (fall back to the default, same as any other unrecognized string, not a crash)', () => {
            expect(mapRequestedScopeToRaw('MEDIA')).toEqual(['read', 'write']);
            expect(mapRequestedScopeToRaw('Media')).toEqual(['read', 'write']);
            // "MEDIA:READ" must NOT resolve to the narrow grant — case folding
            // is deliberately not implemented (device-scope-map.ts rationale).
            expect(mapRequestedScopeToRaw('MEDIA:READ')).toEqual(['read', 'write']);
        });
    });

    describe('prototype-pollution resistance — Object.prototype member names never throw or leak', () => {
        // These are exactly the strings that resolve to a truthy, non-iterable
        // value when a plain object literal is indexed by an attacker-controlled
        // key ("obj[key]"), because they walk the prototype chain instead of
        // returning undefined. `[...hit]` on any of them throws `TypeError: hit
        // is not iterable` — unauthenticated, since POST /oauth/device sets no
        // format constraint on `scope`. A test that only checked "unknown string
        // -> default" would have passed against that broken code; these names
        // are the point.
        it.each([
            'constructor',
            'toString',
            'valueOf',
            'hasOwnProperty',
            '__proto__',
            'isPrototypeOf',
            'toLocaleString',
        ])('%p returns the default full grant and does not throw', (input) => {
            expect(() => mapRequestedScopeToRaw(input)).not.toThrow();
            expect(mapRequestedScopeToRaw(input)).toEqual(['read', 'write']);
        });
    });

    it('never returns a value that is not one of the table rows (structural closure)', () => {
        const candidates = [
            'media',
            'media:read',
            'admin',
            undefined,
            null,
            '',
            'garbage',
            'media:read admin',
        ];
        for (const candidate of candidates) {
            const result = mapRequestedScopeToRaw(candidate);
            expect(['read,write', 'read'].includes(result.slice().sort().join(','))).toBe(true);
        }
    });
});

describe('KNOWN_DEVICE_REQUEST_SCOPES', () => {
    it('contains exactly the two offerable request strings', () => {
        expect([...KNOWN_DEVICE_REQUEST_SCOPES].sort()).toEqual(['media', 'media:read']);
    });
});
