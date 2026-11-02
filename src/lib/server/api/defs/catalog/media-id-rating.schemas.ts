// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media-id-rating.schemas.ts — Request/response Zod schemas for the
 * `media/{id}/rating` endpoint.
 *
 * Kept in a separate lightweight module (no server imports) so the colocated
 * `_openapi.ts` generator can import the schemas directly without pulling in the
 * full endpoint def and its runtime dependencies (database.service, valkey-glide
 * native binary, etc.), which would cause the OpenAPI generator process to hang
 * because the native Valkey addon's Tokio thread pool prevents process exit.
 *
 * Both `media-id-rating.ts` (the def) and the colocated `_openapi.ts` import
 * from here — single source of truth, zero drift.
 */

import { z } from 'zod';

/**
 * PUT body schema for media/{id}/rating.
 *
 * Lenient by design — preserves the handler's historical behaviour:
 *   - `rating` is coerced from string|number (the old code did `Number(...)`)
 *   - bounds 0–10 (0 removes); unknown fields are stripped, not rejected.
 */
export const RatingBody = z.object({
    rating: z.coerce.number().min(0).max(10),
    ratingStyle: z.enum(['quick', 'stars']).optional(),
});
