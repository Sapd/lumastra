// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which sign-in method the first-run wizard recommends (and pre-selects).
 *
 * Lives in a non-`+` sibling module so the preference order is unit-tested.
 * Single sign-on is the recommendation (Denis, 2026-10-14): a forward-auth
 * identity detected from a TRUSTED peer → forward auth (the proxy already does
 * SSO); otherwise OIDC, configured or not. Built-in login is never badged; it
 * stays one click away for installs without an identity provider.
 */

export type SetupMethod = 'forward-auth' | 'native' | 'oidc';

export function recommendedSetupMethod(input: {
    oidcEnabled: boolean;
    /** A forward-auth identity from a trusted peer (`data.forwardAuth !== null`). */
    forwardAuthDetected: boolean;
}): SetupMethod {
    if (input.oidcEnabled) return 'oidc';
    if (input.forwardAuthDetected) return 'forward-auth';
    return 'oidc';
}

/**
 * The card pre-selected on step 1: the recommended one. When OIDC is configured
 * its recommended action is the "Sign in with …" button above the cards, so NO
 * card is pre-selected (null) and Continue stays disabled until the operator
 * picks a fallback. Unconfigured, the OIDC card is selected and Continue opens
 * its setup form.
 */
export function initialSetupMethod(input: {
    oidcEnabled: boolean;
    forwardAuthDetected: boolean;
}): SetupMethod | null {
    return input.oidcEnabled ? null : recommendedSetupMethod(input);
}
