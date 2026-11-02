// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin nav pins response schema (`GET /api/admin/nav-pins`).
 *
 * Split out of `$lib/schemas/api-admin-responses` (2026-09-25) so
 * `$lib/api/nav-pins`'s `getNavPins()` — used by Sidebar.svelte on every page
 * — doesn't have to import that whole, much heavier schema file just for this
 * one response shape. Re-exported from `api-admin-responses.ts` so existing
 * importers are unaffected.
 */

import { z } from 'zod';

/** A single pinned admin nav item, as returned by GET /api/admin/nav-pins. */
export const AdminNavPinSchema = z.object({
    href: z.string(),
    label: z.string(),
    sortOrder: z.number(),
});

export type AdminNavPin = z.infer<typeof AdminNavPinSchema>;

export const AdminNavPinListResponseSchema = z.object({
    pins: z.array(AdminNavPinSchema),
});

export type AdminNavPinListResponse = z.infer<typeof AdminNavPinListResponseSchema>;
