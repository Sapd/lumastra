// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Shared SSR/client-fetch suppression policy for every Browse entry route. */
export function shouldSuppressBrowseWatching(
    user: { isAgeRestricted?: boolean } | null | undefined,
): boolean {
    return !user || user.isAgeRestricted === true;
}
