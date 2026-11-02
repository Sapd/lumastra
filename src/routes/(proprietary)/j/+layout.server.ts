// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { config } from '$lib/server/config';
import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async () => {
    // Mirror the authoritative kill switch in resolveAuth() exactly: the raw
    // FEATURE_JELLYFIN_COMPAT flag. /j compat serves Lumastra's OWN catalog, so
    // it does NOT require a configured Jellyfin backend. `features.jellyfinCompat`
    // is now defined as exactly this flag and is pinned to agree with it by
    // config.jellyfin-compat-flag.test.ts — it used to additionally demand
    // JELLYFINURL/APIKEY, which left /j reachable here while the Connections UI
    // and the /j password APIs that gate on the feature vanished.
    if (!config.FEATURE_JELLYFIN_COMPAT) {
        error(404, 'Not Found');
    }
    return {};
};
