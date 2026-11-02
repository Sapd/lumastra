// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins the device-flow grant shown on the consent screen.
 *
 * These assertions are the security contract a TV login is approved under:
 * a shared-room device with no lock screen must never carry admin capability.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDeviceGrantCapabilities } from './device-grant-capabilities.js';

describe('bearer-path drift pin', () => {
    // This module reconstructs the bearer principal independently. Until
    // 2026-08-05 that meant it could not observe forward-auth.ts starting to
    // pass real scopes on the bearer path — the two hardcoded `tokenScopes: []`
    // literals were accidentally, not structurally, consistent. Both sides now
    // call the SAME `mapRequestedScopeToRaw()` (device-scope-map.ts), so the
    // pin moves from "the literal is []" to "both call sites use the shared
    // function" — this is what actually prevents the two from drifting apart
    // again (e.g. someone inlining a re-derived mapping in only one place).
    it('forward-auth.ts computes the bearer principal tokenScopes via mapRequestedScopeToRaw()', () => {
        const src = readFileSync(
            fileURLToPath(new URL('../middleware/forward-auth.ts', import.meta.url)),
            'utf8',
        );
        const bearerBlock = src.slice(src.indexOf("kind: 'bearer',"));
        expect(bearerBlock).toContain('tokenScopes: mapRequestedScopeToRaw(');
        expect(bearerBlock.indexOf('tokenScopes: mapRequestedScopeToRaw(')).toBeLessThan(600);
        expect(src).toContain(
            "import { mapRequestedScopeToRaw } from '$lib/server/oauth/device-scope-map.js';",
        );
    });

    it('device-grant-capabilities.ts (this module) also calls mapRequestedScopeToRaw() — same function, not a re-derived copy', () => {
        const src = readFileSync(
            fileURLToPath(new URL('./device-grant-capabilities.ts', import.meta.url)),
            'utf8',
        );
        expect(src).toContain("from '$lib/server/oauth/device-scope-map.js'");
        expect(src).toContain('mapRequestedScopeToRaw(');
    });
});

describe('getDeviceGrantCapabilities', () => {
    it('never grants admin — even when an admin approves the device', () => {
        const caps = getDeviceGrantCapabilities('media');
        expect(caps.grantsAdmin).toBe(false);
    });

    it('grants no admin-class scope', () => {
        const { granted } = getDeviceGrantCapabilities('media');
        expect(granted).not.toContain('admin');
        expect(granted).not.toContain('tasks:admin');
        expect(granted).not.toContain('tasks:run'); // POST /libraries/scan
        expect(granted).not.toContain('access:admin'); // /access/groups CRUD
        expect(granted).not.toContain('users:admin');
        expect(granted).not.toContain('library:admin');
        expect(granted.filter((s) => s.endsWith(':admin'))).toEqual([]);
    });

    it('grants the media read/write set a player actually needs', () => {
        const { granted } = getDeviceGrantCapabilities('media');
        expect(granted).toContain('read');
        expect(granted).toContain('write');
        expect(granted).toContain('media:read');
        expect(granted).toContain('media:write');
        expect(granted).toContain('sessions:read');
    });

    it('reports a requested scope as ignored (the grant is fixed)', () => {
        const caps = getDeviceGrantCapabilities('media');
        expect(caps.requested).toBe('media');
        expect(caps.requestedIsIgnored).toBe(true);
    });

    it('reports no requested scope when the device sent none', () => {
        for (const empty of [null, '', '   ']) {
            const caps = getDeviceGrantCapabilities(empty);
            expect(caps.requested).toBeNull();
            expect(caps.requestedIsIgnored).toBe(false);
            expect(caps.requestedIsKnown).toBe(false);
        }
    });

    describe('requestedIsKnown', () => {
        // Only a recognized request is echoed verbatim on the consent screen;
        // anything else is arbitrary text from an unauthenticated endpoint.
        it('recognizes the scope tvOS sends', () => {
            expect(getDeviceGrantCapabilities('media').requestedIsKnown).toBe(true);
            expect(getDeviceGrantCapabilities('  media  ').requestedIsKnown).toBe(true);
        });

        it('rejects an unknown token, including alongside a known one', () => {
            // 'media:read' is DELIBERATELY removed from this list as of
            // 2026-08-05 — it is now the second offerable device scope (§1.2
            // of the design doc) and is asserted recognized separately below.
            for (const scope of ['admin', 'media admin', 'Media', 'openid']) {
                expect(getDeviceGrantCapabilities(scope).requestedIsKnown).toBe(false);
            }
        });

        it('recognizes the new read-only scope', () => {
            expect(getDeviceGrantCapabilities('media:read').requestedIsKnown).toBe(true);
        });

        it('rejects a truncated scope — the tail it was cut from is unknown', () => {
            expect(getDeviceGrantCapabilities('m'.repeat(5000)).requestedIsKnown).toBe(false);
        });

        it('does not let a recognized request widen the grant', () => {
            expect(getDeviceGrantCapabilities('media').granted).toEqual(
                getDeviceGrantCapabilities('anything-else').granted,
            );
        });
    });

    it('caps a pathologically long requested scope for display', () => {
        // oauth_device_codes.scope is an unbounded text column fed from the
        // device's own request, so length is attacker-controlled.
        const caps = getDeviceGrantCapabilities('m'.repeat(5000));
        expect(caps.requested!.length).toBeLessThanOrEqual(201); // 200 + ellipsis
        expect(caps.requested!.endsWith('…')).toBe(true);
        expect(caps.requestedIsIgnored).toBe(true);
    });

    it('leaves a normal-length scope untouched', () => {
        expect(getDeviceGrantCapabilities('media').requested).toBe('media');
        expect(getDeviceGrantCapabilities('  media  ').requested).toBe('media');
    });

    it('returns a stable, sorted, duplicate-free list', () => {
        const { granted } = getDeviceGrantCapabilities('media');
        expect(granted).toEqual([...granted].sort());
        expect(new Set(granted).size).toBe(granted.length);
    });

    describe('the "media:read" read-only grant (new 2026-08-05)', () => {
        it('grants the read-closure but excludes write and media:write', () => {
            const { granted } = getDeviceGrantCapabilities('media:read');
            expect(granted).toContain('read');
            expect(granted).toContain('media:read');
            expect(granted).toContain('sessions:read');
            expect(granted).toContain('requests:read');
            // `tasks:read` is NOT in the read closure: the auto-grant was
            // removed by the 2026-09-18 fix-plan-4 "Shape C" ruling, because
            // every non-admin session inheriting it is what let findings
            // C2/C4/C5 recur. Asserting its ABSENCE turns this pin into a
            // regression guard for that fix rather than a record of the bug.
            expect(granted).not.toContain('tasks:read');
            // `runs:read` is NOT in the read closure either since aed56c43ef
            // (2026-10-07): run history is operator-only, reversing the
            // 2026-09-13 P4 ruling.
            expect(granted).not.toContain('runs:read');
            expect(granted).not.toContain('write');
            expect(granted).not.toContain('media:write');
        });

        it('never grants admin — even when an admin approves the device (worst case, same as the full grant)', () => {
            expect(getDeviceGrantCapabilities('media:read').grantsAdmin).toBe(false);
        });

        it('is a strict subset of the "media" grant', () => {
            const readOnly = new Set(getDeviceGrantCapabilities('media:read').granted);
            const full = new Set(getDeviceGrantCapabilities('media').granted);
            for (const scope of readOnly) {
                expect(full.has(scope)).toBe(true);
            }
            expect(readOnly.size).toBeLessThan(full.size);
        });

        it('a recognized "media:read" request actually narrows the grant, so it is NOT reported as ignored', () => {
            const caps = getDeviceGrantCapabilities('media:read');
            expect(caps.requested).toBe('media:read');
            expect(caps.requestedIsKnown).toBe(true);
            expect(caps.requestedIsIgnored).toBe(false);
        });
    });
});
