// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A results view with no filter has nothing to show — send it back to rails.
 *
 * Reachable by a hand-edited URL or a stale bookmark. Same answer the UI gives
 * when the last chip is cleared, kept in one place so the two cannot disagree.
 */

import { redirect } from '@sveltejs/kit';
import { appPath } from '$lib/shared/api-urls.js';
import { filterRedirectTarget } from '$lib/shared/browse-filter-route.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
    const target = filterRedirectTarget(url);
    // appPath, not resolve — a redirect Location must be root-absolute. See the
    // sibling /browse/az loader.
    if (target) redirect(307, appPath(target));
    return {};
};
