// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin identity & Jellyfin-mapping operations for the Users admin UI.
 *
 * Read/maintain a user's federated identities (user_identities ledger — OIDC /
 * native / forward_auth) and their Jellyfin account mapping. Pure logic over the
 * query modules; HTTP/admin-gating lives in the routes. AGPL-core.
 */

import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import {
    getUserByUsername,
    getNativeLoginRecord,
    getJellyfinMapping,
    setJellyfinUsername,
} from '$lib/server/database/queries/users.queries.js';
import {
    getIdentitiesForUser,
    deleteIdentityForUser,
} from '$lib/server/database/queries/user-identities.queries.js';
import {
    resolveJellyfinUserId,
    invalidateJellyfinUserIdCache,
} from '$lib/server/services/jellyfin-user-id-resolver.js';
import { getSessionService } from '$lib/server/services/session.service.js';
import { PROVIDER_NATIVE } from '$lib/server/services/user-identity.service.js';

export type AdminIdentityResult<T> =
    { ok: true; data: T } | { ok: false; status: number; message: string };

export interface AdminUserIdentity {
    /** Opaque provider key (e.g. `oidc:<hash>`, `native`, `forward_auth`). */
    provider: string;
    /** Human label for the UI. */
    providerLabel: string;
    /** True for OIDC providers (link removable to force re-link on next login). */
    isOidc: boolean;
    /** Provider subject (OIDC `sub`, or the lowercased username). */
    subject: string;
    email: string | null;
    emailVerified: boolean;
    createdAt: string;
    lastLoginAt: string | null;
}

export interface AdminUserIdentitiesData {
    jellyfin: {
        /** Login override; null = use the Lumastra username. */
        override: string | null;
        /** Cached resolved Jellyfin UUID, if any. */
        cachedUserId: string | null;
        /** The effective Jellyfin login name (override ?? username). */
        effectiveName: string;
    };
    identities: AdminUserIdentity[];
}

function labelFor(provider: string): { label: string; isOidc: boolean } {
    if (provider === 'native') return { label: 'Native password', isOidc: false };
    if (provider === 'forward_auth') return { label: 'Forward auth (proxy)', isOidc: false };
    if (provider.startsWith('oidc:')) {
        return { label: `OIDC — ${config.AUTH_OIDC_PROVIDER_NAME}`, isOidc: true };
    }
    return { label: provider, isOidc: false };
}

/** List a user's federated identities + Jellyfin mapping. */
export async function listUserIdentities(
    sql: postgres.Sql,
    username: string,
): Promise<AdminIdentityResult<AdminUserIdentitiesData>> {
    const lower = username.toLowerCase();
    const user = await getUserByUsername(sql, lower);
    if (!user) return { ok: false, status: 404, message: `User '${username}' not found` };

    const [identities, jf] = await Promise.all([
        getIdentitiesForUser(sql, user.id),
        getJellyfinMapping(sql, lower),
    ]);

    return {
        ok: true,
        data: {
            jellyfin: {
                override: jf?.jellyfin_username ?? null,
                cachedUserId: jf?.jellyfin_user_id ?? null,
                effectiveName: jf?.jellyfin_username ?? user.username,
            },
            identities: identities.map((i) => {
                const { label, isOidc } = labelFor(i.provider);
                return {
                    provider: i.provider,
                    providerLabel: label,
                    isOidc,
                    subject: i.subject,
                    email: i.email,
                    emailVerified: i.email_verified,
                    createdAt: i.created_at.toISOString(),
                    lastLoginAt: i.last_login_at ? i.last_login_at.toISOString() : null,
                };
            }),
        },
    };
}

/** Set (or clear, with null) a user's Jellyfin login override; clears the cache. */
export async function setJellyfinOverride(
    sql: postgres.Sql,
    username: string,
    jellyfinUsername: string | null,
): Promise<AdminIdentityResult<{ override: string | null }>> {
    const lower = username.toLowerCase();
    const user = await getUserByUsername(sql, lower);
    if (!user) return { ok: false, status: 404, message: `User '${username}' not found` };

    const value = jellyfinUsername && jellyfinUsername.trim() ? jellyfinUsername.trim() : null;
    if (value && value.length > 128) {
        return { ok: false, status: 400, message: 'Jellyfin username is too long' };
    }
    await setJellyfinUsername(sql, user.id, value);
    invalidateJellyfinUserIdCache(lower);
    return { ok: true, data: { override: value } };
}

/** Force-resolve (and persist) the user's Jellyfin UUID now — the "test" action. */
export async function resolveJellyfinForUser(
    username: string,
): Promise<AdminIdentityResult<{ jellyfinUserId: string | null }>> {
    const lower = username.toLowerCase();
    // Drop any stale L1 entry so this reflects the current override.
    invalidateJellyfinUserIdCache(lower);
    const id = await resolveJellyfinUserId(lower);
    return { ok: true, data: { jellyfinUserId: id ?? null } };
}

/** Unlink a federated identity from a user (forces re-link on next login). */
export async function unlinkIdentity(
    sql: postgres.Sql,
    username: string,
    provider: string,
    subject: string,
): Promise<AdminIdentityResult<{ unlinked: boolean }>> {
    const lower = username.toLowerCase();
    const user = await getUserByUsername(sql, lower);
    if (!user) return { ok: false, status: 404, message: `User '${username}' not found` };

    // Lockout guard: refuse if removing this identity would leave the user with
    // no login methods at all (native password + other identity rows together).
    const [identities, nativeRecord] = await Promise.all([
        getIdentitiesForUser(sql, user.id),
        getNativeLoginRecord(sql, lower),
    ]);
    const hasNativePassword = nativeRecord?.password_hash != null;
    // Remaining identity rows after this one is removed (provider+subject keyed).
    const remainingIdentities = identities.filter(
        (i) => !(i.provider === provider && i.subject === subject),
    );
    const hasOtherIdentity = remainingIdentities.some((i) => i.provider !== PROVIDER_NATIVE);
    // Native ledger row itself is not a login method — check the password_hash.
    // Forward-auth and OIDC rows in the remaining list are valid login methods.
    if (!hasNativePassword && !hasOtherIdentity) {
        return {
            ok: false,
            status: 409,
            message:
                'Cannot unlink: removing this identity would leave the user with no login methods. ' +
                'Set a native password or ensure another federated identity remains first.',
        };
    }

    const unlinked = await deleteIdentityForUser(sql, user.id, provider, subject);

    if (unlinked) {
        // Revoke sessions so any active session tied to this identity is invalidated.
        await getSessionService().revokeAllForUser(user.id);
    }

    return { ok: true, data: { unlinked } };
}
