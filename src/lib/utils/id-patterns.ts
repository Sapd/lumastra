// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared UUID regex patterns. Client-safe (no server-only imports) so both
 * browser and server code can import from a single canonical source instead
 * of redefining these literals locally.
 */

/** Matches a standard, dashed UUID string (case-insensitive). Use this for
 *  strict validation — the canonical `8-4-4-4-12` hex shape with dashes
 *  required. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Matches a UUID string with optional dashes (case-insensitive). Use this
 *  only where dashless UUIDs are expected on input (e.g. some external IDs) —
 *  prefer {@link UUID_RE} for strict validation. */
export const UUID_RE_LOOSE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * The id itself when it is a dashed media_items UUID, otherwise undefined.
 * Use it before putting an id into `externalIds.internal`: a Jellyfin item id
 * (32 hex, no dashes) or any other provider id is never an internal id.
 */
export function asInternalUuid(id: string | null | undefined): string | undefined {
    return typeof id === 'string' && UUID_RE.test(id) ? id : undefined;
}
