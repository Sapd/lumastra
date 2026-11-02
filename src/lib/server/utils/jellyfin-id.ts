// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin ID Normalization Utility
 *
 * Jellyfin IDs are UUIDs that may arrive with or without dashes depending on the source:
 * - Jellyfin API returns dashed UUIDs (e.g., a1bc9a3d-39d6-8698-370b-bcd45cfb9c11)
 * - URL params may contain either format
 * - Database stores dashless format (e.g., a1bc9a3d39d68698370bbcd45cfb9c11)
 *
 * This utility normalizes Jellyfin IDs to dashless lowercase format for consistent
 * storage and comparison. Internal UUIDs (media_items.id) remain dashed — this
 * normalization applies only to Jellyfin provider IDs in the external_ids table.
 */

/**
 * Normalize a Jellyfin ID to dashless lowercase format.
 * Safe to call on already-dashless IDs (idempotent).
 *
 * @param jellyfinId - Jellyfin UUID in any format (dashed or dashless)
 * @returns Dashless lowercase UUID string
 *
 * @example
 * normalizeJellyfinId('a1bc9a3d-39d6-8698-370b-bcd45cfb9c11')
 * // => 'a1bc9a3d39d68698370bbcd45cfb9c11'
 *
 * normalizeJellyfinId('a1bc9a3d39d68698370bbcd45cfb9c11')
 * // => 'a1bc9a3d39d68698370bbcd45cfb9c11'
 */
export function normalizeJellyfinId(jellyfinId: string): string {
    return jellyfinId.replace(/-/g, '').toLowerCase();
}
