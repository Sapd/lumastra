// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { LocalUser } from '$lib/schemas/api-admin-responses';
import * as m from '$lib/paraglide/messages.js';

function hasLumastraLogin(user: LocalUser): boolean {
    return (
        user.hasNativePassword ||
        (user.identityProviders ?? []).some(
            (provider) => provider === 'oidc' || provider === 'forward_auth',
        )
    );
}

/**
 * An account nobody can use: no Lumastra sign-in, no upstream Jellyfin account,
 * no API token, and no sign-in on record. Jellyfin-only accounts (people who
 * use the upstream Jellyfin server directly) and token-only service accounts
 * are legitimate, so they are NOT flagged.
 */
export function needsLoginAttention(user: LocalUser): boolean {
    return (
        !hasLumastraLogin(user) &&
        !user.jellyfinLinked &&
        !(user.apiTokenCount ?? 0) &&
        !user.groups?.length &&
        !user.lastSeenAt
    );
}

export function loginMethods(user: LocalUser): string {
    const methods: string[] = [];
    if (user.hasNativePassword) methods.push(m.users_directory_password());
    if (user.identityProviders?.includes('oidc')) methods.push('SSO');
    if (user.identityProviders?.includes('forward_auth')) methods.push(m.users_directory_proxy());
    if (methods.length) return methods.join(' · ');
    // No Lumastra sign-in of its own: name what the account is actually used through.
    if (user.jellyfinLinked) return m.users_directory_jellyfin_only();
    if (user.apiTokenCount) return m.users_directory_token_only();
    if (user.groups?.length) return m.users_directory_federated();
    if (user.lastSeenAt) return m.users_directory_previous_login();
    return m.users_directory_no_login();
}

export function lastActive(user: LocalUser): string | null {
    const stamps = [user.lastSeenAt, user.lastActivityAt].filter(
        (value): value is string => Boolean(value) && Number.isFinite(Date.parse(value ?? '')),
    );
    return stamps.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

export const DRAWER_SECTIONS = ['overview', 'access', 'activity', 'livetv'] as const;
export type DrawerSection = (typeof DRAWER_SECTIONS)[number];

/** The provisioner suffixes collisions with -2, -3, …; this is a hint, not proof. */
export function possibleSuffixDuplicates(
    users: LocalUser[],
): Array<{ original: string; duplicate: string }> {
    const names = new Map(users.map((user) => [user.username.toLowerCase(), user.username]));
    return users.flatMap((user) => {
        const match = /^(.*)-([2-9]|[1-9][0-9]+)$/.exec(user.username.toLowerCase());
        const original = match ? names.get(match[1]) : undefined;
        return original ? [{ original, duplicate: user.username }] : [];
    });
}
