// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { config, features } from '$lib/server/config';
import { PersonalAccessTokenSchema } from '$lib/schemas/credentials';
import { getPatService } from '$lib/server/oauth/pat.service';
import { aiDbService } from '$lib/server/services/database.service.js';
import { loadAccountSignIn, type AccountSignIn } from '$lib/server/auth/account-sign-in.js';

/**
 * Route-scoped SSR loader (spec a11y #7): fetch PATs ONLY when the userPats
 * feature is on and the section is viewed. Forward-auth users without the flag
 * never hit the token store.
 */
export const load: PageServerLoad = async ({ locals }) => {
    const patsEnabled = features.userPats === true;
    // How this user actually signs in (password / OIDC / reverse proxy), so the
    // page names the real method and only offers "Change password" when a local
    // password exists. null for an anonymous render (the layout gates that).
    const signIn: AccountSignIn | null = locals.user?.userId
        ? await loadAccountSignIn(await aiDbService.getSql(), {
              userId: String(locals.user.userId),
              authMethod: locals.authMethod,
              sessionId:
                  locals.principal?.kind === 'session'
                      ? (locals.principal.credentialId ?? null)
                      : null,
              oidcProviderName: config.AUTH_OIDC_PROVIDER_NAME,
          })
        : null;
    if (!patsEnabled || !locals.user?.userId) {
        return { tokens: [], patsEnabled, signIn };
    }
    try {
        const patService = getPatService();
        const rawTokens = await patService.listForUser(locals.user.userId);
        // Map PatListItem → UserTokenInfo (dates → ISO strings, add usageCount/lastUsedIp)
        const tokens = rawTokens.map((t) =>
            PersonalAccessTokenSchema.parse({
                id: t.id,
                name: t.name,
                description: t.description,
                tokenPrefix: t.tokenPrefix,
                scopes: t.scopes,
                createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
                expiresAt:
                    t.expiresAt instanceof Date ? t.expiresAt.toISOString() : (t.expiresAt ?? null),
                lastUsedAt:
                    t.lastUsedAt instanceof Date
                        ? t.lastUsedAt.toISOString()
                        : (t.lastUsedAt ?? null),
                lastUsedIp: t.lastUsedIp,
                usageCount: t.usageCount,
                isExpired: t.isExpired,
                allowedIps: t.allowedIps,
            }),
        );
        return { tokens, patsEnabled, signIn };
    } catch {
        // Surface an empty list on failure; the panel renders its own retry.
        return { tokens: [], patsEnabled, signIn };
    }
};
