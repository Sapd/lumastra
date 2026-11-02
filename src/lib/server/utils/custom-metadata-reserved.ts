// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `custom_metadata` keys the server owns. The scanner, matchers and enrichment
 * stages write them and branch on them (re-match, artist splitting, cover-art
 * fetch, AudiobookShelf sync), so the generic admin metadata PATCH endpoints
 * must not overwrite them. Each has its own write path (e.g. the no-split
 * toggle has its own endpoint).
 *
 * Operator-chosen keys (library template fields, `chapters`, `lyrics`) stay
 * writable: a full allowlist is not possible because non-entertainment
 * libraries define their own fields.
 */
export const RESERVED_CUSTOM_METADATA_KEYS: ReadonlySet<string> = new Set([
    'essentia',
    'acoustid',
    'awaiting_provider_match',
    'scan_aliases',
    'no_split',
    'additional_artist_ids',
    'audiobookshelf',
    'recording_mbid',
    'rematch_attempted_at',
    'needs_cover_art_fetch',
    'title_source_verified',
]);

/** Keys of `metadata` that the generic PATCH endpoints must refuse. */
export function reservedCustomMetadataKeys(metadata: Record<string, unknown>): string[] {
    return Object.keys(metadata).filter((key) => RESERVED_CUSTOM_METADATA_KEYS.has(key));
}
