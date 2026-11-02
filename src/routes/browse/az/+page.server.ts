// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { shouldSuppressBrowseWatching } from '../watching-policy.js';

/**
 * Page server loads are route-local, so /browse/az must carry the same policy
 * signal as /browse itself. BrowsePage uses this to disable every client CW
 * fetch/effect for anonymous and age-restricted viewers.
 */
export const load: PageServerLoad = ({ locals }) => ({
    watchingSuppressed: shouldSuppressBrowseWatching(locals.user),
});
