// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Known group names for group-valued settings pickers.
 *
 * Eleven settings carry `uiHints.groups` and several render on the same page, so
 * this is a MODULE-LEVEL cache rather than per-component state: the first input to
 * ask kicks off one request and every other input awaits the same promise. Without
 * it, opening the general settings page would fire a request per group setting.
 *
 * The cache is deliberately per page-load and not invalidated. Group membership
 * changes on a different admin page (`/admin/settings/access`), which is a full
 * navigation, and a stale list here degrades to "the free-text field still works"
 * rather than to a wrong value — see {@link GroupArrayInput} for why unknown names
 * are always accepted.
 *
 * A failed fetch resolves to an empty list and is NOT retried. The picker treats
 * "no known groups" as "cannot verify" rather than "nothing exists", so a dead
 * endpoint costs the admin autocomplete and the unknown-name warning, never the
 * ability to type a value.
 *
 * @module components/admin/inputs/known-groups
 */

import { browser } from '$app/environment';
import { getAvailableGroups } from '$lib/api/admin';

let cached: Promise<string[]> | null = null;

/**
 * Resolve every group name an admin may reference — in-app access groups unioned
 * with groups asserted by the identity provider. Shared across all callers on a
 * page load.
 */
export function loadKnownGroups(): Promise<string[]> {
    // Never cache a server-side result. Module scope on the server is shared by every
    // request, so one failed SSR fetch would pin an empty list for the process's
    // lifetime. Callers use onMount and never reach this, but the guard keeps that
    // from being a precondition a future caller has to know about.
    if (!browser) return Promise.resolve([]);
    cached ??= getAvailableGroups()
        .then(({ data, error }) => {
            if (error || !data) return [];
            return data.groups;
        })
        .catch(() => []);
    return cached;
}

/** Testing seam — drops the cached promise so the next call refetches. */
export function resetKnownGroupsCache(): void {
    cached = null;
}
