// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How the signed-in user actually signs in — for the Settings → Account page.
 *
 * `locals.authMethod === 'session'` covers BOTH built-in login and OIDC (an OIDC
 * callback mints the same kind of session), so it cannot on its own tell a
 * password user from an SSO user. The page used to say "Signed in with your
 * username and password" and offer "Change password" to OIDC-provisioned users
 * who have no local password at all (Linux e2e 2026-09-29).
 */

import type postgres from 'postgres';
import { getAccountSignInFacts } from '$lib/server/database/queries/user-sessions.queries.js';

export type AccountSignInMethod = 'password' | 'oidc' | 'proxy' | 'idp';

export interface AccountSignIn {
    method: AccountSignInMethod;
    /** OIDC provider display name (AUTH_OIDC_PROVIDER_NAME) when method is 'oidc'. */
    providerName: string | null;
    /** A local password exists — the only case where "Change password" can work. */
    hasPassword: boolean;
}

export function resolveAccountSignIn(input: {
    authMethod: string | undefined;
    hasPassword: boolean;
    sessionIsOidc: boolean;
    oidcProviderName: string;
}): AccountSignIn {
    const { authMethod, hasPassword, sessionIsOidc } = input;
    if (authMethod === 'forward_auth') {
        return { method: 'proxy', providerName: null, hasPassword };
    }
    if (authMethod === 'session' && sessionIsOidc) {
        const name = input.oidcProviderName.trim();
        return { method: 'oidc', providerName: name.length > 0 ? name : null, hasPassword };
    }
    return { method: hasPassword ? 'password' : 'idp', providerName: null, hasPassword };
}

/**
 * Load the facts for the current request and resolve them. `sessionId` is the
 * id of the session serving this request (null for non-session auth). On a DB
 * error it falls back to the old authMethod-only reading (a session user is
 * assumed to have a password) — the password endpoint itself still refuses an
 * account without one, so the fallback can't grant anything.
 */
export async function loadAccountSignIn(
    sql: postgres.Sql | null,
    params: {
        userId: string;
        authMethod: string | undefined;
        sessionId: string | null;
        oidcProviderName: string;
    },
): Promise<AccountSignIn> {
    let facts = { hasPassword: params.authMethod === 'session', sessionIsOidc: false };
    if (sql) {
        try {
            facts = (await getAccountSignInFacts(sql, params.userId, params.sessionId)) ?? facts;
        } catch {
            /* legacy fallback — see above */
        }
    }
    return resolveAccountSignIn({
        authMethod: params.authMethod,
        hasPassword: facts.hasPassword,
        sessionIsOidc: facts.sessionIsOidc,
        oidcProviderName: params.oidcProviderName,
    });
}
