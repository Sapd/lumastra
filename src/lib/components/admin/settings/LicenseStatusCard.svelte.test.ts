// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Settings → General → Licensing card with "Contact lumastra.org for the
 * licence" off: it names the state and what the free tier lacks.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import LicenseStatusCard from './LicenseStatusCard.svelte';
import type { LicenseStatusSummary } from './license-status-summary';

const FREE: LicenseStatusSummary = {
    validity: 'free-tier',
    edition: 'free',
    tier: 'free',
    enforcementEnabled: true,
    expiresAt: null,
    modules: ['push'],
    reason: 'Not contacting lumastra.org — running on the free tier.',
    serverContact: false,
};

afterEach(cleanup);

describe('LicenseStatusCard — contact with lumastra.org off', () => {
    it('no key: free tier, and what is lost', () => {
        render(LicenseStatusCard, { props: { status: FREE } });
        const text = screen.getByTestId('license-contact-off').textContent ?? '';
        expect(text).toMatch(/Not contacting lumastra\.org: free tier\./);
        expect(text).toMatch(/2 streams at a time/);
        expect(text).toMatch(/no AI assistant/);
        expect(text).toMatch(/push notifications/);
        expect(text).toMatch(/branding removal/);
    });

    it('a stored key: works until its expiry and is not renewed', () => {
        render(LicenseStatusCard, {
            props: {
                status: {
                    ...FREE,
                    validity: 'valid',
                    edition: 'pro',
                    tier: 'early_access',
                    expiresAt: '2027-01-31T23:59:59.000Z',
                    modules: ['jellyfin_compat', 'ai_assistant', 'branding_removal', 'push'],
                },
            },
        });
        const text = screen.getByTestId('license-contact-off').textContent ?? '';
        expect(text).toMatch(/works until .*2027.* and is not renewed/);
    });

    it('CONTROL: contact on, or a build without enforcement, shows nothing extra', () => {
        render(LicenseStatusCard, { props: { status: { ...FREE, serverContact: true } } });
        expect(screen.queryByTestId('license-contact-off')).toBeNull();
        cleanup();
        render(LicenseStatusCard, {
            props: { status: { ...FREE, enforcementEnabled: false, validity: 'unknown' } },
        });
        expect(screen.queryByTestId('license-contact-off')).toBeNull();
    });
});
