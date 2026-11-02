// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The "no artwork" placeholder, served as BYTES rather than as a redirect.
 *
 * ## Why not a 302
 *
 * The media-image route used to answer a missing image with
 * `302 → /placeholders/popcorn.jpg`. That path is not on the edge's API
 * passthrough, so a client authenticating with a PAT or bearer token — every
 * native client — was bounced to the identity provider and served an HTML login
 * page with **HTTP 200**. Measured on prod 2026-08-28:
 *
 *     GET /api/v1/media/tmdb:603:movie/images/poster?width=150
 *       → 302 https://media.example.com/placeholders/popcorn.jpg
 *       → 302 https://media.example.com/outpost.goauthentik.io/start?rd=/placeholders/…
 *       → 200 text/html, 11131 bytes
 *
 * The client decodes no image and sees a success status, so the card is
 * permanently blank with nothing to log. Serving the bytes removes the hop that
 * leaves the API surface at all, which fixes it without touching edge config.
 *
 * ## Still better for browsers, though not by caching
 *
 * One round trip instead of two, and no redirect chain in a hot image path. It
 * is deliberately NOT client-cacheable — see the note on `no-store` below — so
 * the saving is the hop, not the storage. The cost of re-fetching is bounded
 * anyway: the buffer is read from disk once and memoized, where a miss-heavy
 * poster grid previously `readFile`'d the same 46 KB once per miss.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Logger } from './logger.js';
import { deriveClientType } from './info.utils.js';

const logger = Logger.for('PlaceholderImage');

/** Static files live in `static/` during dev and `build/client/` in production. */
const STATIC_DIRS = [
    path.join(process.cwd(), 'static'),
    path.join(process.cwd(), 'build', 'client'),
];

const PLACEHOLDER_REL_PATH = 'placeholders/popcorn.jpg';

/** Resolved once on first success; `null` until then, `false` once known missing. */
let cached: Buffer | null | false = null;

/**
 * Read the placeholder from disk, memoizing the result.
 *
 * A miss is memoized as `false` too — if the file is not in the image, probing
 * both directories on every missing poster is pure waste.
 */
async function loadPlaceholder(): Promise<Buffer | null> {
    if (cached !== null) return cached === false ? null : cached;
    for (const dir of STATIC_DIRS) {
        try {
            const buffer = await fs.readFile(path.join(dir, PLACEHOLDER_REL_PATH));
            cached = buffer;
            return buffer;
        } catch {
            // Try the next directory.
        }
    }
    logger.warn('Placeholder image not found in any static directory', {
        tried: STATIC_DIRS,
        file: PLACEHOLDER_REL_PATH,
    });
    cached = false;
    return null;
}

/** Test seam: drop the memoized buffer so a suite can re-exercise the read. */
export function _resetPlaceholderCacheForTest(): void {
    cached = null;
}

/**
 * The response an image route should send when it has no image.
 *
 * `clientType` decides the SHAPE, not the status semantics:
 *  - `native`  → 404. Every other image route in this codebase already answers
 *                a miss that way; a native client wants to know there is no
 *                artwork so it can draw its own fallback.
 *  - `browser` → the placeholder bytes, so an `<img>` renders popcorn instead
 *                of a broken-image icon.
 *
 * Neither branch redirects, so no caller can be handed an HTML login page with a
 * success status — which is what made the original bug invisible.
 *
 * ## Why the placeholder is labelled
 *
 * "Misclassification is harmless" is true in only one direction. A browser
 * misread as native shows a broken-image icon: annoying, obvious. A NATIVE
 * client misread as a browser decodes the popcorn successfully and may cache it
 * as though it were real artwork — a wrong image that looks like success at
 * every layer, which is worse than the blank card this replaced.
 *
 * That direction is reachable, and was once the DEFAULT: `authMethod` is
 * undefined for an anonymous request, for a `?sig=` signed URL, and — until
 * `imageClientType` below — for every `/api/v1` image request no matter what
 * credential it carried, because the middleware exempts those paths before it
 * ever reads one. `?sig=` remains classified as a browser by design.
 *
 * So the response says what it is. `X-Lumastra-Placeholder: 1` lets any caller
 * treat it as a miss without depending on being classified correctly, and
 * `Cache-Control: no-store` stops it being retained as artwork by anything that
 * does not read the header. The classification then only decides which
 * *convenience* you get, never whether you can tell what happened.
 */

/** Marks a 200 response whose body is the fallback image, not real artwork. */
export const PLACEHOLDER_HEADER = 'X-Lumastra-Placeholder';

export async function noImageResponse(clientType: 'browser' | 'native'): Promise<Response> {
    if (clientType === 'native') {
        return new Response(null, {
            status: 404,
            headers: { 'Cache-Control': 'no-store', [PLACEHOLDER_HEADER]: '1' },
        });
    }
    const buffer = await loadPlaceholder();
    if (!buffer) {
        // The placeholder itself is missing — 404 rather than redirect to a path
        // that would take a browser out of the API surface for a file we already
        // know is not there.
        return new Response(null, {
            status: 404,
            headers: { 'Cache-Control': 'no-store', [PLACEHOLDER_HEADER]: '1' },
        });
    }
    return new Response(new Uint8Array(buffer), {
        headers: {
            'Content-Type': 'image/jpeg',
            [PLACEHOLDER_HEADER]: '1',
            // Deliberately NOT cached, despite this being a static byte-identical
            // file. A cached placeholder is indistinguishable from cached artwork
            // once it is in a client's store, and the item it stands in for
            // usually gains real artwork shortly after (a metadata pass, an
            // upload). The bandwidth is trivial; a sticky wrong image is not.
            'Cache-Control': 'no-store',
        },
    });
}

/**
 * Which fallback shape this caller should get.
 *
 * `deriveClientType(locals.authMethod)` is the obvious answer and is WRONG on
 * the surface that matters. `handlePublicApiAuth` exempts every
 * `/api/v1/**` path containing `/images/` — the `?sig=` embed carve-out —
 * and that branch returns BEFORE the block that reads `Authorization` /
 * `?api_key=` and assigns `authMethod`. So on `/api/v1` the field is undefined
 * for every image request, including one carrying a perfectly good bearer
 * token, and `deriveClientType` answers 'browser' for all of them. The native
 * branch was unreachable on the one surface native clients use.
 *
 * So ask the REQUEST, not the resolved identity: a presented bearer credential
 * (`Authorization: Bearer …`, or `?api_key=` — the query form AVPlayer and the
 * tvOS Top Shelf extension must use, since neither can set headers) means a
 * native caller. The token is NOT validated here and must not be: this decides
 * only which of two no-content responses you get, never what you may see.
 * Access is already settled by the time we are choosing a fallback.
 *
 * `?sig=` deliberately does NOT count. A signed URL is a public embed
 * credential — it appears in `<img>` tags — so it is not evidence of a native
 * caller, and such a request keeps getting bytes. That residual case is exactly
 * what `PLACEHOLDER_HEADER` exists for.
 */
export function imageClientType(
    request: Request,
    url: URL,
    authMethod: string | undefined,
): 'browser' | 'native' {
    if (deriveClientType(authMethod) === 'native') return 'native';
    if (request.headers.get('Authorization')?.startsWith('Bearer ')) return 'native';
    if (url.searchParams.has('api_key')) return 'native';
    return 'browser';
}
