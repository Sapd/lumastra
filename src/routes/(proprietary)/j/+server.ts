// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import { advertisedBaseUrl } from '$lib/server/proprietary/jellyfin-compat/advertised-base-url';
import type { RequestHandler } from './$types';
import { getPublicSystemInfo } from '$lib/server/proprietary/jellyfin-compat/serializers/system';

// nginx's `location ^~ /j/ { ... }` auto-redirects bare `/j` to `/j/` (a
// built-in nginx behavior for any prefix location ending in "/", not
// something declared in the config). SvelteKit's default `trailingSlash:
// 'never'` would then redirect `/j/` straight back to `/j` — an infinite
// loop, since nothing previously matched the bare route. `'always'` makes
// `/j/` this route's canonical form so the ping-pong resolves in one hop.
// Jellyfin clients (e.g. Streamyfin's reachability check) probe `HEAD {baseUrl}/`
// before rendering their home screen — this endpoint is what they need to reach.
export const trailingSlash = 'always';

export const GET: RequestHandler = async ({ url }) => {
    return json(getPublicSystemInfo(advertisedBaseUrl(url)));
};
