// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * $lib/server/api/defs/ — endpoint definition files for the /api/v1 surface.
 *
 * ## Convention
 *
 * Each file in this directory (or a sub-directory) exports one `EndpointDef`
 * as the named export `def`. The file path determines where the endpoint is
 * mounted. `scripts/gen-api-routes.ts` reads these files and emits the
 * corresponding route files under:
 *
 *   src/routes/api/<path>/+server.ts       (internal surface)
 *   src/routes/api/v1/<path>/+server.ts    (v1 token surface)
 *
 * Both mounts call `mount(def, ctx)` with the appropriate surface context.
 *
 * ## File naming
 *
 * The mapping from def file to route path:
 *
 *   defs/series/[id].ts           → api/series/[id]/ + api/v1/series/[id]/
 *   defs/series/index.ts          → api/series/ + api/v1/series/
 *   defs/media/[id]/similar.ts    → api/media/[id]/similar/ + api/v1/…
 *
 * `index.ts` in a directory maps to the collection route (no extra segment).
 *
 * ## Example
 *
 * ```ts
 * // defs/series/index.ts
 * import { defineEndpoint } from '$lib/server/api/define.js';
 * import { json } from '@sveltejs/kit';
 *
 * export const def = defineEndpoint({
 *   auth: { kind: 'user' },
 *   handlers: {
 *     GET: async (event, ctx) => {
 *       return json({ items: [], page: { limit: 20, offset: 0, hasMore: false } });
 *     },
 *   },
 * });
 * ```
 *
 * The `scripts/gen-api-routes.ts` generator only touches files for defs it
 * finds here; unrelated routes under src/routes/api/v1/ are unaffected.
 */

// This file is documentation only — no exports.
export {};
