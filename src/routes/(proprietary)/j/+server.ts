// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import { advertisedBaseUrl } from '$lib/server/proprietary/jellyfin-compat/advertised-base-url';
import type { RequestHandler } from './$types';
import { getPublicSystemInfo } from '$lib/server/proprietary/jellyfin-compat/serializers/system';

// `/j/` is this route's canonical path (`trailingSlash: 'always'`). Clients
// may still be handed the base URL `/j` without a trailing slash: nginx's
// `location ^~ /j/` redirects that to `/j/` (built-in behavior for prefix
// locations ending in "/", not declared in the config). With SvelteKit's
// default 'never', `/j/` would redirect back to `/j` in a loop, so 'always'
// keeps the round trip to one hop.
// Jellyfin clients (e.g. Streamyfin's reachability check) probe `HEAD {baseUrl}/`
// before rendering their home screen — this endpoint is what they need to reach.
export const trailingSlash = 'always';

export const GET: RequestHandler = async ({ url }) => {
    return json(getPublicSystemInfo(advertisedBaseUrl(url)));
};
