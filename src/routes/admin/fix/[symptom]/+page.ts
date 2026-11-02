// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolves one signpost id. The three symptoms with real diagnostics behind
 * them (`new-files`, `slow`, `wrong-match`) have their own static route
 * directories, which SvelteKit matches ahead of this dynamic segment — so this
 * only ever sees signpost ids and typos.
 *
 * Only the ID crosses the load boundary. A `Signpost` holds Paraglide message
 * FUNCTIONS, which are not serializable into the SSR payload; returning the
 * object would work in dev-time client navigation and break on first paint.
 */

import { error } from '@sveltejs/kit';
import { findSignpost } from '$lib/components/admin/fix/signposts.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
    const signpost = findSignpost(params.symptom);
    if (signpost === undefined) {
        error(404, 'Unknown symptom');
    }
    return { symptomId: signpost.id };
};
