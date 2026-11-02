// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * api/pagination.ts — client-facing pagination helpers.
 *
 * Re-exports the shared `{ items, page }` envelope primitives from
 * `$lib/schemas/pagination.ts` (the single source of truth — schemas must
 * stay the base layer, so the implementation lives there, not here) so API
 * client wrapper modules (`src/lib/api/*.ts`) can pull pagination helpers
 * from the same `api/` namespace as their `apiGet`/`apiPost` imports.
 */

export { PageBlockSchema, paginatedEnvelope, type PageBlock } from '$lib/schemas/pagination';
