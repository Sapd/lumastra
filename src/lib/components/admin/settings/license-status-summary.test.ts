// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { licensePhase } from './license-status-summary';

describe('licensePhase', () => {
    it('no key inside the build grace window → grace', () => {
        expect(licensePhase({ validity: 'grace', tier: 'grace', enforcementEnabled: true })).toBe(
            'grace',
        );
    });

    it('an early-access key → early-access, also while expiring or in key grace', () => {
        for (const validity of ['valid', 'expiring-soon', 'expired'] as const) {
            expect(licensePhase({ validity, tier: 'early_access', enforcementEnabled: true })).toBe(
                'early-access',
            );
        }
    });

    it('a paid key → licensed', () => {
        expect(licensePhase({ validity: 'valid', tier: 'pro', enforcementEnabled: true })).toBe(
            'licensed',
        );
    });

    it('no usable license → free-tier (incl. a key expired past its grace, reported as tier free)', () => {
        expect(
            licensePhase({ validity: 'free-tier', tier: 'free', enforcementEnabled: true }),
        ).toBe('free-tier');
        expect(licensePhase({ validity: 'expired', tier: 'free', enforcementEnabled: true })).toBe(
            'free-tier',
        );
    });

    it('enforcement off → unrestricted, whatever the key says', () => {
        expect(licensePhase({ validity: 'grace', tier: 'grace', enforcementEnabled: false })).toBe(
            'unrestricted',
        );
        expect(licensePhase({ validity: 'unknown', tier: 'unlicensed' })).toBe('unrestricted');
    });
});
