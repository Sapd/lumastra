// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';

/**
 * Client-safe shape of the license status shown in Settings → General →
 * Licensing. A plain-data projection of the server's `LicenseStatus` (which
 * carries a `ReadonlySet` and lives under `$lib/server/**`, so a component
 * cannot import it).
 */
export interface LicenseStatusSummary {
    validity: 'grace' | 'free-tier' | 'valid' | 'expiring-soon' | 'expired' | 'unknown';
    edition: 'free' | 'pro' | 'enterprise' | 'unlimited';
    /** The license's tier claim ('early_access', 'pro', …), 'grace', or 'free'. */
    tier: string;
    /** False on a build with the paywall off — nothing is gated there. */
    enforcementEnabled: boolean;
    /** ISO date (license expiry, or the end of the grace window), or null. */
    expiresAt: string | null;
    /** Commercial module ids the license unlocks. */
    modules: string[];
    /** Server's human-readable explanation of the validity. */
    reason: string;
    /** LICENSE_SERVER_CONTACT_ENABLED: false = this server never calls lumastra.org. */
    serverContact?: boolean;
}

/**
 * The one-line answer to "what is this install running on?", shared by the
 * Settings card and the System → Instance panel so both say the same thing:
 *
 * - `grace`        — no key yet; full access until `expiresAt` (grace end)
 * - `early-access` — an early-access key; everything until `expiresAt`
 * - `licensed`     — a supporter/enterprise key (valid, expiring or in grace)
 * - `free-tier`    — no usable license; the restricted free tier
 * - `unrestricted` — enforcement off (dev builds); nothing is gated
 */
export type LicensePhase = 'grace' | 'early-access' | 'licensed' | 'free-tier' | 'unrestricted';

export function licensePhase(s: {
    validity: LicenseStatusSummary['validity'];
    tier: string;
    enforcementEnabled?: boolean;
}): LicensePhase {
    if (s.enforcementEnabled === false || s.validity === 'unknown') return 'unrestricted';
    if (s.validity === 'grace') return 'grace';
    if (s.validity === 'free-tier') return 'free-tier';
    // 'expired' past the 14-day key grace reports tier 'free' (free entitlements).
    if (s.tier === 'free' || s.tier === 'unlicensed') return 'free-tier';
    if (s.tier === 'early_access') return 'early-access';
    return 'licensed';
}

/**
 * Human label for a raw tier string ('early_access', 'pro', 'enterprise', …).
 * Rendering `tier` directly (with a blind `capitalize` CSS class) showed
 * "Early_access" verbatim — the underscore survives text-transform. Known
 * tiers get a proper label; an unrecognised one (a future tier the licensing
 * server starts issuing before this build knows its name) is humanized
 * (underscores to spaces, each word capitalized) rather than shown raw.
 */
export function tierLabel(tier: string): string {
    switch (tier) {
        case 'early_access':
            return m.admin_licensing_early_access();
        case 'grace':
            return m.admin_licensing_grace();
        case 'free':
            return m.admin_licensing_free_tier();
        case 'unlicensed':
            return m.admin_licensing_tier_unlicensed();
        case 'pro':
            return m.admin_licensing_tier_pro();
        case 'enterprise':
            return m.admin_licensing_tier_enterprise();
        case 'unlimited':
            return m.admin_licensing_tier_unlimited();
        case 'licensed':
            return m.admin_licensing_tier_licensed();
        default:
            return tier
                .split(/[_\s]+/)
                .filter(Boolean)
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');
    }
}
