// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * access-gate.ts — shared resource-level access gate for media sub-resources.
 *
 * Applies the same library-group + age-rating gate that GET /media/{id} uses
 * (via `checkMediaAccess`) before allowing comment or reaction operations on a
 * media item. Returns 404 on denial — matching `media-id.ts:129` behaviour.
 *
 * The `targetId` received from the factory is the raw `event.params.id` string
 * (the media UUID or composite key). For simplicity the gate passes it directly
 * to `checkMediaAccess`, which accepts UUIDs. Composite-key callers that need
 * resolution should resolve the id before reaching this layer; however, for
 * comment/reaction routes the client is expected to use the internal UUID.
 */

import { ApiProblem } from '$lib/server/api/problem.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import type { AccessGateFn } from '$lib/server/api/defs/interactions/handlers.js';

/**
 * Media access gate for the `AccessGateFn` contract.
 *
 * Returns `null` (allow) when `checkMediaAccess` passes; returns a 404 problem
 * response when it denies — identical to the guard in `catalog/media-id.ts`.
 */
export const mediaAccessGate: AccessGateFn = async (sql, targetId, event, _op) => {
    const user = event.locals.user;

    const allowed = await checkMediaAccess(sql, targetId, user);
    if (!allowed) {
        return ApiProblem.notFound('Media not found');
    }

    return null; // allowed
};
