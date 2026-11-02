// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { manualRunActor, manualRunActorFromApiAuth } from './run-trigger-actor.js';

const USER_ID = '42bcfdbf-2647-4591-8c9c-d6120cf15768';

describe('manualRunActor', () => {
    it('attributes a service token run to the token, not its creator', () => {
        expect(
            manualRunActor({
                kind: 'service_token',
                userId: USER_ID,
                username: 'service:test-minter',
            }),
        ).toBe('service:test-minter');
    });

    it.each(['session', 'forward_auth', 'pat', 'bearer'])('keeps the user id for %s', (kind) => {
        expect(manualRunActor({ kind, userId: USER_ID, username: 'testuser' })).toBe(USER_ID);
    });

    it('falls back when there is no principal', () => {
        expect(manualRunActor(undefined)).toBe('unknown');
        expect(manualRunActor(null)).toBe('unknown');
    });
});

describe('manualRunActorFromApiAuth', () => {
    it('uses the service identity username for svc tokens', () => {
        expect(
            manualRunActorFromApiAuth({
                tokenKind: 'svc',
                tokenId: '13',
                userId: USER_ID,
                identity: { username: 'service:sonarr' },
            }),
        ).toBe('service:sonarr');
    });

    it('never falls back to the creator id for a svc token without identity', () => {
        expect(
            manualRunActorFromApiAuth({ tokenKind: 'svc', tokenId: '13', userId: USER_ID }),
        ).toBe('service:13');
    });

    it('keeps the user id for PATs', () => {
        expect(manualRunActorFromApiAuth({ tokenKind: 'pat', tokenId: '7', userId: USER_ID })).toBe(
            USER_ID,
        );
    });
});
