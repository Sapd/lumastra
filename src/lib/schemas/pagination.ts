// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pagination API Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for the canonical `{ items, page }` pagination
 * envelope shared across the API surface. Before this file existed, several
 * near-identical `PageBlockSchema` copies had drifted apart (some carried
 * `nextCursor`, some didn't) across `api-for-you-responses.ts`,
 * `api-playback-responses.ts`, `api-admin-responses.ts`, and the private modules' API schemas.
 *
 * `PageBlockSchema` here is the SUPERSET shape — `limit`/`hasMore` required,
 * `offset`/`nextCursor`/`total` all optional — matching the server's
 * `PageBlock` interface (`$lib/server/api/problem.ts`), the type the runtime
 * `paginate()` helper actually produces.
 *
 * Usage:
 * - Server: Validate responses before sending
 * - Client: Runtime type validation
 * - OpenAPI: Auto-generate documentation
 * - TypeScript: Infer types for type safety
 */

import { z, type ZodTypeAny } from 'zod';

/**
 * Canonical page block returned alongside every paginated collection.
 * Superset shape: `offset`, `nextCursor`, and `total` are all optional so this
 * single schema is compatible with both offset-based and cursor-based
 * pagination callers.
 */
export const PageBlockSchema = z
    .object({
        limit: z.number().int(),
        offset: z.number().int().optional(),
        nextCursor: z.string().optional(),
        hasMore: z.boolean(),
        total: z.number().int().optional(),
    })
    .meta({ id: 'PageBlock', description: 'Canonical pagination metadata block' });

export type PageBlock = z.infer<typeof PageBlockSchema>;

/**
 * Build the canonical `{ items, page }` paginated envelope schema for a given
 * item schema — the shape produced by the server's `paginate()` helper
 * (`$lib/server/api/problem.ts`).
 */
export function paginatedEnvelope<T extends ZodTypeAny>(itemSchema: T) {
    return z.object({
        items: z.array(itemSchema),
        page: PageBlockSchema,
    });
}

/** Bounded top-N collections expose truncation without promising another page. */
export function boundedListEnvelope<T extends ZodTypeAny>(itemSchema: T) {
    return z.object({
        items: z.array(itemSchema),
        truncated: z.boolean(),
    });
}
