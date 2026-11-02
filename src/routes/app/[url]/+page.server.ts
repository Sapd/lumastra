// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Server guard for the external-service iframe embed route.
 *
 * The page frames the URL carried in the path. This load enforces that the
 * target is one an admin actually configured as an external navigation link —
 * matched by origin — so the route cannot be abused to frame arbitrary hostile
 * sites inside the trusted app chrome. See `$lib/server/embed-allowlist.ts` for the rationale.
 *
 * security review 2026-09-13, C18: the global CSP's `frame-src` is a fixed
 * YouTube-only allowlist PLUS every admin-configured external-link origin
 * (hooks.server.ts, via `configuredEmbedOrigins`). This route used to set its
 * own scoped `frame-src <origin>` header instead, but a document's CSP is fixed
 * at document load: the dock navigates here with a client-side `goto()`, which
 * only fetches `__data.json`, so that header never reached the page and the
 * iframe was blocked until a full reload.
 */

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { get as getConfigValue } from '$lib/server/config/config.service';
import {
    configuredEmbedOrigins,
    resolveAllowedEmbedUrl,
    type ConfiguredLink,
} from '$lib/server/embed-allowlist';

export const load: PageServerLoad = async ({ params }) => {
    let decoded: string;
    try {
        decoded = decodeURIComponent(params.url);
    } catch {
        // Malformed percent-encoding — treat as not found (no existence leak).
        throw error(404, 'Not found');
    }

    const allowedOrigins = configuredEmbedOrigins((key) =>
        getConfigValue<ConfiguredLink[] | undefined>(key),
    );

    const url = resolveAllowedEmbedUrl(decoded, allowedOrigins);
    if (!url) {
        throw error(404, 'Not found');
    }

    // Validated, normalized absolute URL — the page frames exactly this.
    return { url };
};
