// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AGPL-core registry for the optional /j (Jellyfin-compat) live
 * session store. Mirrors `ai/assistant-provider.ts`: the core never imports the
 * `jellyfin-compat` tree. Instead that module registers itself here via
 * {@link registerJellyfinCompatRevocationProvider}, at boot.
 *
 * Consumed by `credential-revocation.service.ts` so disabling / resetting the
 * password of / deleting a user also tears down their live /j Valkey sessions
 * (`jellyfin-compat/auth.ts` `revokeSessionsForUser`), which otherwise survive
 * every AGPL-core revoke primitive.
 *
 * Registered in `boot/compat-init.ts` (`ensureCompatLoaded()`), together with the
 * AI-assistant provider.
 * When the /j tree is absent (a build with it deleted), nothing registers
 * and {@link getJellyfinCompatRevocationProvider} returns `null` — a safe
 * no-op, since such a build has no /j sessions to revoke in the first
 * place.
 */

export interface JellyfinCompatRevocationProvider {
    /** Revoke every live /j session for this user (a `users.id` UUID). Returns the count revoked. */
    revokeSessionsForUser: (userId: string) => Promise<number>;
}

let provider: JellyfinCompatRevocationProvider | null = null;

/**
 * Called by the jellyfin-compat module (via `boot/compat-init.ts`)
 * on load to wire itself in. (module → core direction, which the
 * boundary permits.)
 */
export function registerJellyfinCompatRevocationProvider(
    p: JellyfinCompatRevocationProvider,
): void {
    provider = p;
}

/** The registered module provider, or `null` in AGPL-only builds. */
export function getJellyfinCompatRevocationProvider(): JellyfinCompatRevocationProvider | null {
    return provider;
}

/** Test seam: reset the registered provider. */
export function __resetJellyfinCompatRevocationProviderForTests(): void {
    provider = null;
}
