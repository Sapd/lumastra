// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// authz: public — intentional Jellyfin-compat image endpoint (matches upstream Jellyfin unauthenticated images); existence oracle collapsed via default-on-miss

// Jellyfin Compatibility Layer — Item Image Proxy
//
// GET /Items/{itemId}/Images/{imageType}[/{imageIndex}]
//
// Serves item images for Swiftfin and other Jellyfin clients.
// No auth required — Jellyfin's own image endpoints are unauthenticated
// and clients load images in <img> tags without sending auth headers.
//
// Maps Jellyfin imageType names to internal ImageType values:
//   Primary  → poster (thumb for episodes — see below)
//   Backdrop → backdrop
//   Logo     → logo
//   Thumb    → thumb
//
// Size parameters follow Jellyfin's ImageController (see box-resize.ts):
// width/height, maxWidth/maxHeight, fillWidth/fillHeight, quality, format.

import type { RequestEvent } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger';
import { noImageResponse } from '$lib/server/utils/placeholder-image.js';
import { normalizeImageType } from '$lib/server/utils/image-validation';
import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy';
import type { ImageResponse, ImageType } from '$lib/server/services/image-proxy';
import {
    getCatalogImageInBox,
    isEmptyBox,
    type BoxOutputFormat,
    type ImageBox,
} from '$lib/server/services/image-proxy/box-resize';
import { parseQualityParam } from '$lib/server/utils/image-proxy';
import { getParam } from './utils';
import { getDb } from '$lib/server/database';
import { getProgramById } from '$lib/server/database/queries/livetv-programs.queries';
import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries.js';
import { isEpisode } from '$lib/server/utils/media-types.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries';
import { isUuid } from '$lib/server/utils/media-key-parser';
import {
    getLibraryBackdrop,
    getLibraryPlaceholder,
    type BackdropResult,
} from '$lib/server/services/library-backdrop.service';
import { canonicalGroupId, verifyLibraryImageTag } from './library-image-tag';
import { jellyfinImageTag, type ImageRole } from './image-enrichment';
import { verifyPersonImageTag } from './people-studios';

const logger = Logger.for('JellyfinCompat:ItemImage');

/**
 * Serve the default placeholder image (popcorn.jpg) as a 200 response.
 *
 * Used whenever an item has no artwork OR the itemId is unknown — both cases
 * are collapsed to the same response so the endpoint cannot be used as an
 * existence oracle. That is why this surface must NOT adopt the 404 that
 * `/api/v1` returns to native callers: the status is load-bearing here.
 *
 * Delegates to the shared `noImageResponse`, always on its browser branch,
 * which is exactly the always-200-with-bytes shape this endpoint needs. Two
 * things change by doing so, and both were live defects:
 *
 *  - The response is now LABELLED (`X-Lumastra-Placeholder`) and `no-store`.
 *    It used to be unlabelled with `public, max-age=86400` — a decodable JPEG
 *    that a client caches for a day and cannot distinguish from real artwork.
 *    Anti-oracle makes that worse, not better: the cached tile may be standing
 *    in for "no artwork" or for "no such item", and the client cannot tell
 *    which, nor notice when real artwork arrives.
 *
 *  - The old last-resort branch, taken when the file could not be read, was
 *    `302 → /placeholders/popcorn.jpg`. That path is gated by forward auth at
 *    the edge, so the redirect landed in the identity provider and answered
 *    with an HTML login page at HTTP 200 — the same defect fixed on `/api/v1`.
 *    The shared helper answers 404 instead. That stays oracle-safe: it depends
 *    only on whether the placeholder file exists on disk, which is identical
 *    for every item id.
 */
async function defaultImageResponse(): Promise<Response> {
    return noImageResponse('browser');
}

/** Map Jellyfin image type names to internal ImageType values */
const JELLYFIN_IMAGE_TYPE_MAP: Record<string, ImageType> = {
    primary: 'poster',
    backdrop: 'backdrop',
    logo: 'logo',
    thumb: 'thumb',
    banner: 'banner',
    still: 'still',
};

/** Library tiles: one 16:9 mosaic serves every type UserViews advertises. */
const LIBRARY_IMAGE_TYPES = new Set(['primary', 'thumb', 'backdrop']);

/** Jellyfin's cache lifetime for a request that carries the image tag. */
const TAGGED_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** The box parameters, in Jellyfin's query-string spelling. */
const BOX_PARAMS = [
    ['Width', 'width'],
    ['Height', 'height'],
    ['MaxWidth', 'maxWidth'],
    ['MaxHeight', 'maxHeight'],
    ['FillWidth', 'fillWidth'],
    ['FillHeight', 'fillHeight'],
] as const;

/** The Jellyfin image types whose tags image-enrichment.ts mints. */
const TAGGED_ROLES: Record<string, ImageRole> = {
    primary: 'Primary',
    backdrop: 'Backdrop',
    logo: 'Logo',
    thumb: 'Thumb',
};

/**
 * `?quality=` in any of the spellings `getParam` accepts, when it is a valid
 * 1-100 integer; undefined otherwise (the encoder default applies).
 */
export function parseRequestedQuality(url: URL): number | undefined {
    const raw = getParam(url, 'Quality');
    if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
    const value = Number.parseInt(raw, 10);
    return value >= 1 && value <= 100 ? value : undefined;
}

/** ASP.NET's int binding: an optional sign and digits, nothing else. */
const INT_RE = /^[+-]?\d+$/;

/**
 * Parse the size box. A value that is not an integer is a 400, like
 * Jellyfin's model binding; zero or a negative number means "unset" (Jellyfin
 * ignores them); anything larger than the cap is clamped in box-resize.
 */
export function parseImageBox(url: URL): ImageBox | { invalid: string } {
    const box: ImageBox = {};
    for (const [param, key] of BOX_PARAMS) {
        const raw = getParam(url, param);
        if (raw === null || raw === '') continue;
        if (!INT_RE.test(raw.trim())) return { invalid: param };
        const value = Number.parseInt(raw, 10);
        if (value > 0) box[key] = value;
    }
    return box;
}

/** Jellyfin `ImageFormat` names this route can produce; others are ignored. */
export function parseImageFormat(url: URL): BoxOutputFormat | undefined {
    const raw = getParam(url, 'Format')?.toLowerCase();
    if (raw === 'jpg' || raw === 'jpeg') return 'jpg';
    if (raw === 'png' || raw === 'webp') return raw;
    return undefined;
}

function libraryImageResponse(mosaic: BackdropResult, request: Request): Response {
    const etag = `"${mosaic.contentHash}"`;
    // The URL carries the signed tag, which rotates weekly — private caching
    // for a day is safe and keeps tiles from refetching on every render.
    const cacheControl = 'private, max-age=86400';
    if (request.headers.get('if-none-match') === etag) {
        return new Response(null, {
            status: 304,
            headers: { ETag: etag, 'Cache-Control': cacheControl },
        });
    }
    return new Response(new Uint8Array(mosaic.buffer), {
        headers: { 'Content-Type': mosaic.contentType, 'Cache-Control': cacheControl, ETag: etag },
    });
}

export async function handleItemImage(
    event: Pick<RequestEvent, 'params' | 'url' | 'request' | 'locals'>,
): Promise<Response> {
    const { params, url, request, locals } = event;
    const itemId = params.itemId;
    const imageType = params.imageType ?? '';

    if (!itemId) {
        return new Response('Item ID required', { status: 400 });
    }

    // /{imageIndex}: this compatibility surface advertises only the first
    // elected image. Other indices are unsupported and receive no cache proof.
    // Neither answer depends on the item, so this is no existence oracle.
    const rawIndex = params.imageIndex;
    if (rawIndex !== undefined) {
        if (!/^\d+$/.test(rawIndex)) {
            return new Response('Invalid image index', { status: 400 });
        }
        if (Number.parseInt(rawIndex, 10) !== 0) {
            return new Response(null, { status: 404 });
        }
    }

    const box = parseImageBox(url);
    if ('invalid' in box) {
        return new Response(`Invalid ${box.invalid}`, { status: 400 });
    }

    const normalizedType = normalizeImageType(imageType);
    let internalType: ImageType =
        (normalizedType !== null ? JELLYFIN_IMAGE_TYPE_MAP[normalizedType] : undefined) ?? 'poster';

    const requestedQuality = parseRequestedQuality(url);
    const quality = requestedQuality ?? parseQualityParam(url);
    const format = parseImageFormat(url);
    const tag = getParam(url, 'tag');

    // Library (CollectionFolder) artwork — the mosaic generated from the
    // library's items. This route is `authz: public` and never sees a user
    // (`/j/*` is self-authenticating per route and this one is not wrapped in
    // `withJellyfinAuth`), so it cannot gate a library on its caller; that is
    // why it stopped serving the mosaic on 2026-09-17 (C10). The capability
    // is now the ImageTag: `/j/UserViews` (authenticated, denied groups
    // excluded) advertises a signed tag per library, clients echo it as
    // `?tag=`, and only a tag minted for THIS id unlocks the mosaic. Any other
    // request — no tag, a forged or expired one, a tag for another library —
    // falls through to the catalog lookup below and lands on the same default
    // placeholder an unknown id gets (anti-oracle, see defaultImageResponse).
    if (LIBRARY_IMAGE_TYPES.has(normalizedType ?? '') && verifyLibraryImageTag(itemId, tag)) {
        const sql = getDb();
        if (sql) {
            const groupId = canonicalGroupId(itemId);
            const mosaic =
                (await getLibraryBackdrop(sql, groupId)) ??
                (await getLibraryPlaceholder(sql, groupId));
            if (mosaic) return libraryImageResponse(mosaic, request);
        }
    }

    // Person headshot: the tag is the capability (people-studios.ts) — it
    // names the TMDB person and is signed for this id, so no lookup runs and
    // an unsigned request for a person id gets the anonymous placeholder.
    if (normalizedType === 'primary') {
        const tmdbPersonId = verifyPersonImageTag(itemId, tag);
        if (tmdbPersonId !== null) {
            const large = Math.max(
                box.width ?? 0,
                box.maxWidth ?? 0,
                box.fillWidth ?? 0,
                ((box.height ?? 0) || (box.maxHeight ?? 0) || (box.fillHeight ?? 0)) * (2 / 3),
            );
            const headshot = await getImageProxyService()
                .getPersonImage(String(tmdbPersonId), {
                    rawSize: large > 185 ? 'h632' : 'w185',
                    quality,
                })
                .catch((err: unknown) => {
                    logger.debug('person headshot fetch failed', { error: String(err) });
                    return null;
                });
            if (headshot) {
                return imageResponse({ ...headshot, cacheControl: TAGGED_CACHE_CONTROL }, request, {
                    keepCacheControl: true,
                });
            }
            return defaultImageResponse();
        }
    }

    const service = getImageProxyService();
    // Without a box the route keeps its old call (default quality included).
    // With one, only a quality the client asked for overrides the encoder's.
    const boxQuality = isEmptyBox(box) ? quality : requestedQuality;
    const fetchImage = (id: string, type: ImageType): Promise<ImageResponse | null> =>
        getCatalogImageInBox(service, id, type, box, {
            quality: boxQuality,
            format,
            revision: tag ?? undefined,
        });
    const role = TAGGED_ROLES[normalizedType ?? ''];

    // DEAD CODE: `locals.user` is NEVER populated on
    // this route in production, by the exact same evidence CRITICAL 1 above
    // used to remove the mosaic branch — `forward-auth.ts`'s `resolveAuth`
    // passes every `/j/*` path straight through with no identity resolved,
    // and this route is wrapped in `withErrorHandler` only, never
    // `withJellyfinAuth` (the thing that actually writes `locals.user`, at
    // `jellyfin-compat/middleware.ts:317,433`). So `if (locals.user)` is
    // always false and `checkMediaAccess` never runs here: item artwork on
    // this route is neither age- nor library-gated for anyone, authenticated
    // or not (there is no "authenticated" on this route).
    //
    // Left in place, NOT deleted and NOT authenticated: whether Jellyfin
    // clients may fetch artwork without credentials is a product decision
    // about this whole surface (it is documented `authz: public`, matches
    // upstream Jellyfin's own unauthenticated image behavior, and is
    // pre-existing — review 4 never raised it), not something this task
    // should settle unilaterally by adding real auth. This comment exists so
    // the block is not mistaken for a live gate by the next reader, and so a
    // future author wiring up `/j` authentication does not have to
    // rediscover that this specific `if` has never once been true.
    if (locals.user) {
        const sql = getDb();
        if (sql) {
            const accessible = await checkMediaAccess(sql, itemId, locals.user);
            if (!accessible) {
                return new Response(null, { status: 404 });
            }
        }
    }

    // Real Jellyfin serves an episode's "Primary" image as its still (16:9),
    // not a poster (2:3) — episodes carry no poster art of their own, so the
    // unconditional Primary->poster mapping made every episode inherit the
    // season/series poster via the ancestor-walk lookup (same thumbnail for
    // every episode). Resolve media_type once so episode Primary requests
    // use the per-episode thumb pipeline (which has its own ffmpeg-extracted
    // still fallback) instead.
    if (normalizedType === 'primary') {
        const sql = getDb();
        if (sql) {
            const mediaType = await getMediaType(sql, itemId).catch(() => null);
            if (isEpisode(mediaType)) {
                internalType = 'thumb';
            }
        }
    }

    let result = await fetchImage(itemId, internalType);

    // Live TV program fallback: programs aren't in media_items, so the catalog
    // lookup misses. We expose programs to clients with ImageTags.Primary='0'
    // pointing at /Items/{programId}/Images/Primary — resolve the program to its
    // owning channel and serve the channel logo instead so EPG card art shows.
    if (!result) {
        const sql = getDb();
        if (sql) {
            try {
                const program = await getProgramById(sql, itemId);
                if (program) {
                    result = await fetchImage(program.channel_id, internalType);
                }
            } catch (err) {
                logger.debug('program→channel image fallback failed', {
                    itemId,
                    error: (err as Error).message,
                });
            }
        }
    }

    // Version picker: jellyfin-androidtv shows the picked version as an item whose
    // Id is the media_files id (see /j/Items/[itemId]), so its artwork is asked
    // for under the file id. Serve the owning item's art — the 2160p pick of a
    // movie otherwise showed no logo (prod 2026-10-02). Same anti-oracle answer
    // as before when the id is not a file either.
    // Only a UUID can be a file id: no lookup for junk ids on this public route.
    const sql = getDb();
    if (!result && sql && isUuid(itemId)) {
        const ownerItemId = await getOwnerItemForFile(sql, itemId).catch((err) => {
            logger.debug('file → owner lookup failed', { itemId, error: String(err) });
            return null;
        });
        if (ownerItemId) {
            // The episode Primary → still mapping above ran on the file id
            // (no media type); decide it again for the owning item.
            let ownerType = internalType;
            if (normalizedType === 'primary') {
                const ownerMediaType = await getMediaType(sql, ownerItemId).catch(() => null);
                if (isEpisode(ownerMediaType)) ownerType = 'thumb';
            }
            result = await fetchImage(ownerItemId, ownerType);
        }
    }

    if (!result) {
        // Collapse the existence oracle: return the same default placeholder
        // whether the itemId is unknown or the item simply has no artwork.
        // This prevents clients from probing item existence via image 404 vs 200.
        logger.debug('Item image not found; serving default placeholder', { itemId, imageType });
        return defaultImageResponse();
    }

    // A tagged request names one version of the image (the tag hashes the
    // image's source, see image-enrichment.ts): Jellyfin caches those for a
    // year, immutable. New artwork means a new tag, so a new URL.
    // Only the CURRENT tag earns that: a stale one (old artwork, a serializer
    // id-prefix tag, a tag for another role) keeps the normal caching, or a
    // client would keep the old picture under that URL for a year.
    // The byte provider reads the elected candidate again AFTER fetching and
    // only supplies servedRevision when those bytes still match that selection.
    // The listing hashes that exact canonical revision too. Recompute its tag
    // directly: another recursive source/ancestor read here adds no byte proof.
    // Legacy, stale, or changed-during-fetch bytes carry no servedRevision.
    if (
        result.servedRevision &&
        tag &&
        role &&
        jellyfinImageTag(itemId, role, `canonical:${result.servedRevision}`) === tag
    ) {
        result = { ...result, cacheControl: TAGGED_CACHE_CONTROL };
    }
    return imageResponse(result, request, { keepCacheControl: true });
}
