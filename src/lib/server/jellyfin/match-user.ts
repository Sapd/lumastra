// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Find the Jellyfin user whose name matches a Lumastra username, case-
 * insensitively. Watch-sync attributes a user's history by matching
 * `LOWER(COALESCE(jellyfin_username, username))` to the Jellyfin account name,
 * so the setup wizard uses this to warn when the admin's own username has no
 * matching Jellyfin user (their history would never import).
 *
 * Returns the matched Jellyfin name (verbatim) or null.
 */
export function matchJellyfinUsername(
    username: string,
    jellyfinUserNames: readonly string[],
): string | null {
    const target = username.trim().toLowerCase();
    if (target === '') return null;
    return jellyfinUserNames.find((name) => name.trim().toLowerCase() === target) ?? null;
}
