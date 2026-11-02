// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { deriveSurface, type PlaySurface } from './play-surface.js';
import type { Principal, PrincipalKind } from './principal.js';
import type { UserId } from '$lib/shared/user-id.js';

function principal(kind: PrincipalKind, clientId?: string): Principal {
    return {
        kind,
        userId: '00000000-0000-0000-0000-000000000001' as UserId,
        username: 'tester',
        userGroups: [],
        scopes: ['read', 'write'],
        isAdmin: false,
        ...(clientId ? { clientId } : {}),
    };
}

describe('deriveSurface', () => {
    // Total over PrincipalKind. If a kind is added without a row here this
    // fails, which is the point — the switch is exhaustive at compile time and
    // this pins the runtime verdicts.
    const cases: Array<[PrincipalKind, string | undefined, PlaySurface]> = [
        ['forward_auth', undefined, 'web'],
        ['session', undefined, 'web'],
        ['bearer', 'lumastra-ios', 'native_app'],
        ['bearer', 'lumastra-tvos', 'native_app'],
        ['bearer', 'some-third-party-player', 'third_party_api'],
        ['bearer', undefined, 'third_party_api'],
        ['pat', undefined, 'third_party_api'],
        ['service_token', undefined, 'third_party_api'],
        ['stream_token', undefined, 'unknown'],
    ];

    for (const [kind, clientId, expected] of cases) {
        it(`maps ${kind}${clientId ? ` (${clientId})` : ''} to ${expected}`, () => {
            expect(deriveSurface(principal(kind, clientId))).toBe(expected);
        });
    }

    it('returns unknown when there is no principal', () => {
        // Internal replay paths (session-manager's ingestLumastra first
        // sighting) run with no request behind them.
        expect(deriveSurface(undefined)).toBe('unknown');
        expect(deriveSurface(null)).toBe('unknown');
    });

    it('ignores a client_id on a non-bearer credential', () => {
        // A PAT cannot buy first-party attribution by carrying the claim.
        expect(deriveSurface(principal('pat', 'lumastra-ios'))).toBe('third_party_api');
    });

    it('counts a bearer impersonating a first-party client_id as first-party', () => {
        // DOCUMENTED BEHAVIOUR, not an oversight. /oauth/device is
        // unauthenticated and the device flow has no client registration, so
        // client_id is self-declared. Accepted because nothing reads `surface`
        // for an authorization decision — it labels a statistics card. If that
        // ever stops being true, this test is the tripwire.
        expect(deriveSurface(principal('bearer', 'lumastra-ios'))).toBe('native_app');
    });

    it('does not resolve prototype keys as first-party client ids', () => {
        // FIRST_PARTY_CLIENT_IDS is a Set precisely so an attacker-controlled
        // client_id cannot reach through Object.prototype.
        for (const proto of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
            expect(deriveSurface(principal('bearer', proto))).toBe('third_party_api');
        }
    });
});
