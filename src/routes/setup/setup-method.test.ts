// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { recommendedSetupMethod, initialSetupMethod } from './setup-method';

describe('recommendedSetupMethod', () => {
    it('prefers OIDC when it is configured, even with forward auth detected', () => {
        expect(recommendedSetupMethod({ oidcEnabled: true, forwardAuthDetected: true })).toBe(
            'oidc',
        );
    });

    it('recommends forward auth when a trusted identity was detected', () => {
        expect(recommendedSetupMethod({ oidcEnabled: false, forwardAuthDetected: true })).toBe(
            'forward-auth',
        );
    });

    it('recommends OIDC on a plain install, never built-in login', () => {
        expect(recommendedSetupMethod({ oidcEnabled: false, forwardAuthDetected: false })).toBe(
            'oidc',
        );
    });
});

describe('initialSetupMethod', () => {
    it('pre-selects the forward-auth card when headers were detected', () => {
        expect(initialSetupMethod({ oidcEnabled: false, forwardAuthDetected: true })).toBe(
            'forward-auth',
        );
    });

    it('pre-selects nothing when OIDC is configured (its button is the recommendation)', () => {
        expect(initialSetupMethod({ oidcEnabled: true, forwardAuthDetected: false })).toBeNull();
    });

    it('pre-selects the OIDC card on a plain install', () => {
        expect(initialSetupMethod({ oidcEnabled: false, forwardAuthDetected: false })).toBe('oidc');
    });
});
