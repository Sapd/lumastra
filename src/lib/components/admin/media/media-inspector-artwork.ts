// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which artwork MediaInspector shows for a media type, and in what shape.
 *
 * ## Why a table rather than an if/else in the component
 *
 * `media-type-domain.ts` rule 2: every internal→X mapping is a
 * `Record<MediaTypeInternal, …>` object literal, never a switch and never an
 * if/else chain, so adding a member to `INTERNAL_MEDIA_TYPES` is a compile
 * error here until somebody decides what that type's artwork is. An if/else in
 * the component would instead have defaulted a new type to whatever the last
 * arm returned — which for artwork means a guaranteed 404 per row, or (worse,
 * without `fallback=none`) a popcorn placeholder claiming to be the item.
 *
 * ## Why the value is a LIST
 *
 * The chain is a per-role fallback, walked by the component when a request
 * 404s. Only one request is made at a time: the next candidate is tried only
 * after the previous one's `<img>` fires `error`. An empty list means "this
 * type has no artwork worth asking for" — the component then renders nothing
 * and issues no request at all.
 *
 * ## Why these particular chains
 *
 * - **movie / tv** — `backdrop` first: 16:9 costs ~236px at the panel's 420px
 *   width, where the 2:3 poster would cost ~630px and push everything below
 *   Identity out of view. Poster second because plenty of items have a poster
 *   and no backdrop, and a small poster beside the fields beats no artwork.
 * - **episode / extra** — `thumb` is the ONLY role that resolves an episode's
 *   OWN still/extracted frame (see `image-utils.ts`); `poster` and `backdrop`
 *   both inherit from the season/series, so every episode of a show would
 *   render the identical image and prove nothing about the row in hand.
 * - **season** — `poster` FIRST, inverted from movie/tv on purpose: a season's
 *   backdrop inherits from the series, so backdrop-first makes all 8 seasons
 *   look the same. The season poster is the thing that differs.
 * - **audiobook / book / manga / comic / podcast / product** — cover only.
 *   `ImageProxyService` deliberately serves no backdrop for a book rather than
 *   stretching its cover (`image-proxy/service.test.ts`: "serves no backdrop
 *   for a book"), so asking for one is a known-miss round trip.
 * - **artist / album / track / audio** — cover art only, and square rather
 *   than 2:3, which is why the inline shape sets a width and lets the natural
 *   aspect decide the height instead of forcing a ratio.
 * - **tvchannel / radio** — a channel logo is all there is, and it is not a
 *   16:9 image.
 * - **home_video / training / educational / personal** — user-supplied video
 *   with no provider metadata; an extracted frame is the only identity there
 *   is, with the poster as the fallback for the rare sidecar.
 * - **music** — a LIBRARY ROOT marker, not an entity. Nothing to show.
 * - **anfragen / sonarr / radarr** — provider-leaked bookkeeping rows. No
 *   artwork exists for them by construction, so an empty chain keeps
 *   arrow-walking a folder of them from firing a 404 per keypress.
 */

import { toInternalMediaType, type MediaTypeInternal } from '$lib/shared/media-type-domain';

/** The image roles this panel is willing to ask for. */
export type ArtworkRole = 'backdrop' | 'poster' | 'thumb';

/**
 * How a role is laid out in a 420px panel.
 *
 * - `hero` — full panel width, height from the natural aspect, cropped only
 *   where the cap bites. For landscape roles.
 * - `inline` — a fixed narrow column with the natural aspect intact. For
 *   portrait posters and square cover art, where full-width would either cost
 *   630px of height or crop a poster down to a meaningless middle band.
 */
export type ArtworkShape = 'hero' | 'inline';

const ROLE_SHAPE: Readonly<Record<ArtworkRole, ArtworkShape>> = {
    backdrop: 'hero',
    thumb: 'hero',
    poster: 'inline',
};

/** Layout shape for a role. */
export function artworkShapeOf(role: ArtworkRole): ArtworkShape {
    return ROLE_SHAPE[role];
}

/**
 * internal media type → the roles to try, best first.
 *
 * Exhaustive by construction. Do NOT rewrite as a switch or an if/else chain;
 * the completeness check is the entire point (see the module comment).
 */
const ARTWORK_CANDIDATES: Readonly<Record<MediaTypeInternal, readonly ArtworkRole[]>> = {
    movie: ['backdrop', 'poster'],
    tv: ['backdrop', 'poster'],
    episode: ['thumb', 'poster'],
    season: ['poster', 'backdrop'],
    extra: ['thumb', 'poster'],
    audiobook: ['poster'],
    book: ['poster'],
    manga: ['poster'],
    comic: ['poster'],
    podcast: ['poster'],
    artist: ['poster'],
    album: ['poster'],
    track: ['poster'],
    audio: ['poster'],
    music: [],
    tvchannel: ['poster'],
    radio: ['poster'],
    home_video: ['thumb', 'poster'],
    training: ['thumb', 'poster'],
    educational: ['thumb', 'poster'],
    personal: ['thumb', 'poster'],
    product: ['poster'],
    anfragen: [],
    sonarr: [],
    radarr: [],
};

const NO_ARTWORK: readonly ArtworkRole[] = [];

/**
 * Roles to try for a row's `media_type`, best first.
 *
 * Takes the raw stored string (the browser row carries `media_type` as a plain
 * `string`) and normalises it through the domain's own alias table, so
 * `'Series'`, `'show'` and `'tv'` all land on the same chain. An unrecognised
 * value yields an empty chain — "I don't know what this is" must not become a
 * confident request for a movie backdrop.
 */
export function artworkCandidatesFor(mediaType: string | null | undefined): readonly ArtworkRole[] {
    const internal = toInternalMediaType(mediaType);
    if (!internal) return NO_ARTWORK;
    return ARTWORK_CANDIDATES[internal];
}
