// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';
import { mediaIdResolver } from '$lib/server/services/media-id-resolver.js';
import { isSeries } from '$lib/server/utils/media-types.js';

/** Series routes resolve the path alone; query parameters never override identity. */
export async function resolveSeriesId(event: RequestEvent): Promise<string | null> {
    const raw = event.params.id;
    if (!raw) return null;
    try {
        const resolved = await mediaIdResolver.resolveAnyMediaId(raw);
        return resolved.internalId && isSeries(resolved.mediaType) ? resolved.internalId : null;
    } catch {
        return null;
    }
}
