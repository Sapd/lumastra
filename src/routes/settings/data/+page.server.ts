// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { features } from '$lib/server/config';

/**
 * `jellyfinSync` is a getter on the `features` object (not on `config`
 * directly) — see `$lib/server/config`. Surfaced so the client can warn that
 * items watched in Jellyfin may reappear after the next background sync.
 */
export const load: PageServerLoad = async () => {
    return { jellyfinSyncEnabled: features.jellyfinSync };
};
