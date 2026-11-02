// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback incidents moved into Client diagnostics. Old links (health invariants,
 * UsersIssueTable, bookmarks) keep working: the params the new page understands are
 * forwarded and `kind` is forced to playback_incident. Legacy-only params (mediaId,
 * triggerType, from/to, paging) are dropped explicitly — the new page has no such
 * filters, and carrying them along would leave dead params in its URL.
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { appPath } from '$lib/shared/api-urls.js';

/** Filters the client-diagnostics page reads from its URL (besides `kind`). */
const FORWARDED_PARAMS = ['userId', 'deviceId', 'q', 'platform'] as const;

export const load: PageServerLoad = ({ url }) => {
    const params = new URLSearchParams();
    for (const name of FORWARDED_PARAMS) {
        const value = url.searchParams.get(name);
        if (value) params.set(name, value);
    }
    params.set('kind', 'playback_incident');
    redirect(308, appPath(`/admin/users/client-diagnostics?${params.toString()}`));
};
