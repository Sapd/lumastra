// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/resolve-id.ts — shared ID resolution for catalog detail/traversal
 * defs.
 *
 * The redesigned catalog defs run inside `mount(def)` and receive a plain
 * RequestEvent. They accept the following ID forms, in order of preference:
 *
 *   1. `event.locals.resolvedIds.internalId` — populated by the
 *      `withIdResolution` middleware when the route wraps the mounted handler
 *      (path param: UUID / composite key / dashless UUID).
 *   2. `?externalId=provider:id:type` — resolved inline here via the same
 *      `mediaIdResolver` the middleware uses, so the def works even when the
 *      route is a bare `mount(def)` with no middleware.
 *   3. Any non-empty `id` path param — a dashed UUID, a composite key
 *      (`provider:id:type`), or a bare dashless Jellyfin UUID — resolved
 *      inline via the resolver, which checks the internal PK before falling
 *      back to a Jellyfin `external_id` lookup. A dashed UUID is NOT
 *      short-circuited: it may be a Jellyfin external id (also UUID-shaped),
 *      so it must still be routed through the resolver rather than assumed
 *      to already be the internal id.
 *
 * This mirrors the resolution contract documented on `media/{id}` and
 * `series/{id}`: internal UUID, composite key, `?externalId=`, or a bare
 * Jellyfin ID.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { UUID_RE } from '$lib/utils/id-patterns.js';

/** True when the string is a canonical (dashed) UUID. */
export function isUuid(value: string): boolean {
    return UUID_RE.test(value);
}

/**
 * Resolve the internal media UUID for a catalog def handler.
 *
 * Returns the resolved internal UUID, or `null` when the id could not be
 * resolved (caller should respond `not_found`). Throws nothing — resolver
 * failures collapse to `null`.
 */
export async function resolveCatalogInternalId(event: RequestEvent): Promise<string | null> {
    // 1. Pre-resolved by withIdResolution middleware (path param).
    const fromMiddleware = event.locals.resolvedIds?.internalId;
    if (fromMiddleware) return fromMiddleware;

    // 2. ?externalId=provider:id:type — resolve inline.
    const externalId = event.url.searchParams.get('externalId');
    if (externalId) {
        const resolved = await tryResolve(externalId);
        if (resolved) return resolved;
    }

    // 3. Any other non-empty id (dashed UUID, composite key, or a bare
    // dashless Jellyfin UUID) — route through the resolver, which checks the
    // internal PK before treating it as a Jellyfin external ID. A dashed UUID
    // is NOT returned as-is here: it may be a Jellyfin external id rather
    // than the internal id, so it must go through the same check.
    const rawId = event.params.id ?? '';
    if (rawId) {
        const resolved = await tryResolve(rawId);
        if (resolved) return resolved;
    }

    return null;
}

/** Resolve any ID form through the shared resolver; null on any failure. */
async function tryResolve(rawId: string): Promise<string | null> {
    try {
        const { mediaIdResolver } = await import('$lib/server/services/media-id-resolver.js');
        const resolved = await mediaIdResolver.resolveAnyMediaId(rawId);
        return resolved.internalId ?? null;
    } catch {
        return null;
    }
}
