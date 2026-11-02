// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The content half of a rich push notification.
 *
 * The APNs payload is content-free on purpose: it crosses the Lumastra-operated
 * relay, which forwards every self-hosted install's notifications and must never
 * learn what media a user is being notified about. So the payload carries only
 * `data.id`, `data.kind` and `data.v` — and the client's Notification Service
 * Extension fetches the real text and the artwork from THE USER'S OWN SERVER,
 * keyed on the notification UUID it already has.
 *
 * This module holds everything both ends of that fetch need and nothing else:
 *
 *  - the two signed-URL purposes (distinct, so an image credential can never be
 *    replayed against the content endpoint or vice versa),
 *  - the expiry window and how it is anchored,
 *  - `resolvePushImageTarget` — which media item's artwork the image endpoint
 *    serves, and whether any artwork exists at all.
 *
 * The TEXT half — `composePushContent`, the localized {title, body} the content
 * endpoint returns — now lives in `push-content-text.ts` and is RE-EXPORTED
 * here, so existing importers are unaffected. The split exists because that half
 * is pure while everything below needs a `postgres.Sql` and a recursive-CTE
 * artwork probe; the inbox presenter renders text for a whole page of rows and
 * must be able to import it without any of that. Importers who only want the
 * text should import `push-content-text.js` DIRECTLY — going through this module
 * pulls the artwork half in transitively and defeats the split.
 *
 * Deliberately free of URL literals so the API defs can import it: the signed
 * paths live in `push-rich-urls.ts`, which only the send path needs.
 *
 * @module services/push/push-rich-content
 */

import type postgres from 'postgres';
import { KIND_LIBRARY_NEW_EPISODE, KIND_REQUEST_AVAILABLE } from '$lib/shared/user-event-kinds.js';
import { isRecord } from '$lib/utils/data-extraction.js';
import { getInheritedImagePresence } from '$lib/server/database/queries/catalog-operations.queries.js';
import {
    getLocalArtwork,
    getOwnLocalArtwork,
} from '$lib/server/database/queries/media-artwork.queries.js';
import { nonEmptyString } from './push-content-text.js';

export { composePushContent, type PushRichContent } from './push-content-text.js';

/** Signed-URL purpose for the artwork endpoint. */
export const PUSH_IMAGE_URL_PURPOSE = 'push-image';

/** Signed-URL purpose for the title/body endpoint. */
export const PUSH_CONTENT_URL_PURPOSE = 'push-content';

/**
 * How long the two signed URLs stay valid: SIX hours, not minutes.
 *
 * `apns-expiration` is `created_at + 4h`, so APNs may hold a notification for
 * four hours before the extension ever runs. A short expiry would therefore fail
 * for exactly one population — people whose phone was off — which is the worst
 * possible failure distribution: the users who most need the banner to still say
 * something useful are the only ones who would get the generic fallback.
 *
 * Six hours is the four-hour APNs window plus headroom for the extension's own
 * scheduling. It is a *ceiling*, not a lease: the expiry is anchored to the
 * notification's `created_at` (see {@link pushRichUrlExpiresInSeconds}), so a
 * delivery retry twenty minutes later mints a URL that expires at the same
 * instant the first one would have. Anchoring to send time instead would let the
 * ladder stretch the credential's life, making its lifetime a property of our
 * queue rather than of the notification.
 */
export const PUSH_RICH_URL_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Seconds of validity left for a URL minted now, anchored to `createdAt`.
 * Zero or negative means the window has already closed — mint nothing.
 */
export function pushRichUrlExpiresInSeconds(createdAt: Date, now: number = Date.now()): number {
    return Math.floor((createdAt.getTime() + PUSH_RICH_URL_TTL_MS - now) / 1000);
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

/** Which media item's artwork a notification's `image_url` serves. */
export interface PushImageTarget {
    mediaId: string;
    role: 'thumb' | 'poster';
}

/**
 * Whether the image byte route would actually serve something for this
 * (item, role) — not whether a URL can be spelled for it.
 *
 * This distinction is the whole point of the check. `posterRef()` in
 * `user-notifier.service.ts` only BUILDS a path; deriving `image_url` from it
 * would make the key present on every notification and 404 whenever the item has
 * no artwork, which is precisely the case the client asked us to make
 * distinguishable (absent ⇒ show no attachment, rather than fetch-then-fail).
 *
 * The two branches mirror `ImageProxyService.tryLocalArtwork` exactly:
 *   - provider metadata / `custom_*` presence, WITH parent-chain inheritance
 *     (`getInheritedImagePresence`), and
 *   - a locally-extracted file (`media_artwork`, source `local`) — inheriting for
 *     `thumb`/`poster`, plus the episode's OWN backdrop row, which is where
 *     ffmpeg-extracted frames land and which the byte route serves as the thumb.
 *     Own-row on purpose: the inheriting backdrop walk would report a series-root
 *     `backdrop.jpg` as every episode's thumb.
 *
 * Under-reporting is the safe direction and is possible (a Jellyfin-only item
 * with no provider metadata resolves at serve time but reads false here): the
 * user gets a banner with no picture, which is what they get today.
 */
async function hasServableArtwork(
    sql: postgres.Sql,
    mediaId: string,
    role: 'thumb' | 'poster',
): Promise<boolean> {
    const presence = await getInheritedImagePresence(sql, mediaId);
    if (presence === null) return false;
    if (presence[role]) return true;

    const local = await getLocalArtwork(sql, mediaId, role);
    if (local?.file_path) return true;

    if (role === 'thumb') {
        const ownBackdrop = await getOwnLocalArtwork(sql, mediaId, 'backdrop');
        if (ownBackdrop?.file_path) return true;
    }

    return false;
}

/**
 * Pick the ONE image a notification's artwork URL resolves to, or null when the
 * install has no artwork for it.
 *
 * The choice is made server-side and is not encoded in the URL: the URL crosses
 * the relay inside the payload, so it may only ever name the notification UUID.
 * The extension gets a single URL, no product context and no choice.
 *
 *   library.new_episode → the episode's own thumbnail when one exists, else the
 *                         series poster. (An episode still is the better card;
 *                         most libraries have one for only some episodes.)
 *   request.available   → the poster of the requested item.
 */
export async function resolvePushImageTarget(
    sql: postgres.Sql,
    kind: string,
    payload: unknown,
): Promise<PushImageTarget | null> {
    const data = isRecord(payload) ? payload : {};

    if (kind === KIND_LIBRARY_NEW_EPISODE) {
        const episodeId = nonEmptyString(data.mediaId);
        if (episodeId && (await hasServableArtwork(sql, episodeId, 'thumb'))) {
            return { mediaId: episodeId, role: 'thumb' };
        }
        const seriesId = nonEmptyString(data.seriesId);
        if (seriesId && (await hasServableArtwork(sql, seriesId, 'poster'))) {
            return { mediaId: seriesId, role: 'poster' };
        }
        return null;
    }

    if (kind === KIND_REQUEST_AVAILABLE) {
        const mediaId = nonEmptyString(data.mediaId);
        if (mediaId && (await hasServableArtwork(sql, mediaId, 'poster'))) {
            return { mediaId, role: 'poster' };
        }
        return null;
    }

    return null;
}
