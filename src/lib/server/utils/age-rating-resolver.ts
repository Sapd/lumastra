// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Build a regex for the age group pattern with a configurable prefix.
 * Matches `{prefix}{N}` case-insensitively (e.g., "age-12", "kids-6").
 */
function buildPattern(prefix: string): RegExp {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}(\\d+)$`, 'i');
}

/**
 * Extract the maximum age rating from a user's OIDC groups.
 *
 * Scans for groups matching the `{prefix}{N}` convention (case-insensitive).
 * Default prefix is `age-` (matches `age-12`, `age-6`, etc.).
 * When multiple age groups are present, the highest value wins (most permissive).
 *
 * @param userGroups - User's OIDC group memberships
 * @param prefix - Group name prefix before the age number (default: 'age-')
 * @returns The maximum age rating, or null if no age groups found (unrestricted).
 */
export function resolveMaxAgeFromGroups(
    userGroups: string[],
    prefix: string = 'age-',
): number | null {
    const pattern = buildPattern(prefix);
    let maxAge: number | null = null;

    for (const group of userGroups) {
        const match = group.match(pattern);
        if (match?.[1]) {
            const age = parseInt(match[1], 10);
            if (Number.isFinite(age) && age >= 0) {
                maxAge = maxAge === null ? age : Math.max(maxAge, age);
            }
        }
    }

    return maxAge;
}

/**
 * Drop group names that follow the `{prefix}{N}` age convention. In-app
 * access-group names pass through this before they join a user's effective
 * group set (`access-control.service.ts`'s `resolveEffectiveAccess`, and the
 * last-admin counts in `access-groups.queries.ts`), so an in-app group can
 * never act as an age group.
 */
export function stripAgeRatingGroupNames(
    names: readonly string[],
    prefix: string = 'age-',
): string[] {
    const pattern = buildPattern(prefix);
    return names.filter((g) => !pattern.test(g));
}
