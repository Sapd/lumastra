// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watched Items Types
 *
 * Convention: All property names use camelCase.
 * Database columns (snake_case) are transformed at the server boundary.
 *
 * Types are re-exported from Zod schemas in '$lib/schemas/watched-types.ts'.
 */

export type { WatchedItemResponse, WatchedItemsData } from '$lib/schemas/watched-types';
