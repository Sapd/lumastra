// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * request-dismissal-key.ts — the ONE place a request-dismissal key is spelled.
 *
 * `user_media_flags(flag_type='request_dismissed')` is written in two shapes
 * (see `docs/architecture/user-events.md`, "The key mapping, written down"):
 *
 *   K-EXT   `tmdb:550:movie` / `tmdb:95350:tv`   target_type 'request'
 *   K-UUID  bare `media_items.id`                 target_type 'movie' | 'series'
 *
 * and `getDismissalsForUser()` hands BOTH shapes to the popup unfiltered. The
 * popup therefore has to be able to build both, and — the part that was wrong
 * for as long as this feature has shipped — it has to spell K-EXT's media-type
 * token the way the WRITER spells it.
 *
 * ## The bug this module exists to prevent
 *
 * K-EXT's token is the storage vocabulary `'tv'`, never the public `'series'`.
 * The server writes it that way (`dismissRequestBodySchema` preprocesses
 * `'series' → 'tv'` before `upsertDismissal` ever sees it). The client built
 * its lookup key from the PUBLIC vocabulary instead, so for a series it asked
 * the map for `tmdb:95350:series` while the row it had just written was
 * `tmdb:95350:tv`. Movies were unaffected — `'movie'` is spelled the same in
 * both vocabularies — which is exactly why this survived: it looked like a
 * working feature that "sometimes" forgot a dismissal.
 *
 * The visible symptom was a fulfilled series request that came back on every
 * focus, forever, because a still-airing show never leaves Jellyseerr's pending
 * list (`media.status = PARTIALLY_AVAILABLE`) and the dismissal that was
 * supposed to hide it could never be found.
 *
 * Both sides now import from here, so the two spellings cannot drift again.
 *
 * Isomorphic: no server-only imports.
 */

import type { ApiMediaType, ExternalIds } from '$lib/types/api-common';
import { buildExternalIdKey, getExternalIdFor, normalizeUuid } from '$lib/utils/external-ids';

/** The media-type token as it appears INSIDE a stored K-EXT key. */
export type DismissalMediaToken = 'movie' | 'tv';

/**
 * Project any media-type vocabulary onto the storage token.
 *
 * Deliberately narrow: only the two series spellings map to `'tv'`, and
 * everything else falls to `'movie'`, because requests exist for nothing but
 * movies and series. A wider mapping here would silently relabel some future
 * third type rather than failing where it could be noticed.
 */
export function toDismissalMediaToken(mediaType: string | null | undefined): DismissalMediaToken {
    const token = (mediaType ?? '').toLowerCase();
    return token === 'tv' || token === 'series' ? 'tv' : 'movie';
}

/**
 * K-EXT: the provider-priority composite, UUIDs excluded.
 *
 * UUIDs are excluded because the pending-sync endpoint rebuilds requests from
 * Jellyseerr's TMDB-only payload — a UUID-keyed row could never be matched
 * there. Returns null when the item carries no external provider id at all.
 */
export function buildRequestDismissalExtKey(
    externalIds: ExternalIds | undefined | null,
    mediaType: string | null | undefined,
): string | null {
    // `buildExternalIdKey` is typed against ApiMediaType ('series', not 'tv')
    // but only interpolates the token verbatim — it never validates the
    // literal. The cast keeps the storage spelling, which stored rows depend on.
    return buildExternalIdKey(externalIds, toDismissalMediaToken(mediaType) as ApiMediaType, {
        includeUuids: false,
    });
}

/**
 * K-UUID: the bare `media_items.id`, which is the only identity an
 * inbox-hydrated card or a For-You dismissal ever has. Media type plays no
 * part — the stored `target_id` is the UUID alone.
 */
export function buildRequestDismissalUuidKey(
    externalIds: ExternalIds | undefined | null,
): string | null {
    const internal = getExternalIdFor(externalIds, 'internal');
    return internal ? normalizeUuid(internal) : null;
}

/**
 * Every key shape under which THIS item may have been dismissed by any surface.
 *
 * A reader must treat a hit on any of them as a dismissal: the popup writes
 * K-EXT, For-You writes K-UUID, the inbox reconcile writes both, and which
 * ones exist depends on what the server could resolve at write time. Checking
 * only the shape this surface happens to write is how "dismissed on my phone,
 * still showing on the TV" comes back.
 */
export function requestDismissalKeys(
    externalIds: ExternalIds | undefined | null,
    mediaType: string | null | undefined,
): string[] {
    const keys: string[] = [];
    const ext = buildRequestDismissalExtKey(externalIds, mediaType);
    if (ext) keys.push(ext);
    const uuid = buildRequestDismissalUuidKey(externalIds);
    if (uuid) keys.push(uuid);
    return keys;
}
