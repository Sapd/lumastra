// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image tags for /j items, the way Jellyfin's DtoService sets them.
 *
 * The serializer only sees the browse row, so it used to advertise a Primary
 * tag for every item (clients then fetched the placeholder instead of drawing
 * their own) and never pointed an episode at its series' images. This pass
 * runs after serialization, reads which images each item and its parents
 * really own (one batched legacy and canonical descriptor read) and sets:
 *
 *  - `ImageTags` / `BackdropImageTags`: only images the item itself has.
 *  - Episode / season: `SeriesPrimaryImageTag`, and for episodes
 *    `ParentPrimaryImageItemId/Tag` (season poster, else series poster).
 *  - Episode / season / track / album (Jellyfin `SupportsInheritedParentImages`):
 *    `ParentLogoItemId/Tag`, `ParentThumbItemId/Tag` (a series thumb wins over
 *    a season's) and `ParentBackdropItemId/Tags`, each only when the item has
 *    none of its own — DtoService.AddInheritedImages. `ParentArt*` is never set:
 *    Jellyfin hard-codes the Art limit to 0 there, and Lumastra has no Art.
 *  - Track: `AlbumPrimaryImageTag` (+ `AlbumId` when nothing set it yet).
 *
 * Tags hash the elected canonical content revision when present, otherwise
 * the legacy source identity. A changed selection gives a new tag, so its URL can be
 * cached for good, like Jellyfin's — the image route marks a tagged response
 * immutable only when its tag matches the canonical revision proven by the byte provider.
 * An image with no stored source still counts when the route would fetch it
 * live: TMDB by the node's tmdb id, a Jellyfin server by its jellyfin id, each
 * only while that provider is in the configured image provider priority.
 *
 * Items this pass cannot find (library views, playlists, programs, …) keep
 * what their serializer set.
 */

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { JellyfinBaseItemDto } from './types';
import {
    getJellyfinItemImages,
    type JellyfinImageNode,
} from '$lib/server/database/queries/jellyfin-item-images.queries.js';
import { Logger } from '$lib/server/utils/logger';
import type {
    ArtworkRole,
    ImageOwnerRow,
} from '$lib/server/database/queries/image-descriptor.queries.js';
import { resolveImageSpecsForOwner } from '$lib/server/services/image-descriptor/resolver.js';
import { config } from '$lib/server/config';
import { DEFAULT_IMAGE_PROVIDER_PRIORITY } from '$lib/server/services/image-proxy/types';
import {
    isAlbum,
    isEpisode,
    isMusicType,
    isSeason,
    isSeries,
    isTrack,
} from '$lib/server/utils/media-types.js';

const logger = Logger.for('JellyfinCompat:ImageEnrichment');

export type ImageRole = 'Primary' | 'Backdrop' | 'Logo' | 'Thumb';

interface ImageTagNode extends JellyfinImageNode {
    canonicalRevisions?: Partial<Record<ImageRole, string>>;
}

/** Overlay elected own identities in one batch; legacy sources remain fallback-only. */
async function getImageTagNodes(sql: postgres.Sql, ids: readonly string[]) {
    const loaded = await getJellyfinItemImages(sql, ids, true);
    const nodes = new Map<string, ImageTagNode>(loaded.nodes);
    const owners = loaded.owners ?? new Map<string, ImageOwnerRow>();
    for (const node of nodes.values()) {
        const owner = owners.get(node.id);
        if (!owner) continue;
        const specs = resolveImageSpecsForOwner(owner, owners, { inherit: 'none' });
        const roles = {
            Primary: isEpisode(node.media_type) ? specs.thumb : (specs.primary ?? specs.poster),
            Backdrop: specs.backdrop,
            Logo: specs.logo,
            Thumb: isEpisode(node.media_type) ? undefined : specs.thumb,
        };
        node.canonicalRevisions = {};
        for (const role of ['Primary', 'Backdrop', 'Logo', 'Thumb'] as const) {
            const spec = roles[role];
            const candidate = spec && owner.selected_candidates?.[spec.urlRole as ArtworkRole];
            if (!spec || spec.ownerId !== owner.id || !candidate) continue;
            // An episode's local backdrop is its extracted Primary frame.
            if (role === 'Backdrop' && isEpisode(node.media_type) && candidate.file_path) continue;
            node.canonicalRevisions[role] = spec.revision;
        }
    }
    return { ...loaded, nodes };
}

/** The serializer's ratio for a 2:3 poster. */
const POSTER_ASPECT_RATIO = 0.667;

/** Jellyfin-shaped (32 hex) tag for one image of one node. */
export function jellyfinImageTag(nodeId: string, role: ImageRole, source: string): string {
    return createHash('md5').update(`${nodeId}|${role}|${source}`).digest('hex');
}

/**
 * The image provider chain the route walks for this node and role — the same
 * choice as ImageProxyService.getProviderPriority (episode-thumb and music
 * overrides, then IMAGE_PROVIDER_PRIORITY, then the default chain).
 */
function providerChain(mediaType: string, still: boolean): readonly string[] {
    const pick = (raw: string[] | null | undefined): string[] | null =>
        Array.isArray(raw) && raw.length > 0 ? raw : null;
    if (still && isEpisode(mediaType)) {
        const override = pick(config.IMAGE_PROVIDER_PRIORITY_EPISODE_THUMB);
        if (override) return override;
    }
    if (isMusicType(mediaType)) {
        return pick(config.IMAGE_PROVIDER_PRIORITY_MUSIC) ?? ['local', 'custom'];
    }
    return pick(config.IMAGE_PROVIDER_PRIORITY) ?? DEFAULT_IMAGE_PROVIDER_PRIORITY;
}

type LiveRole = 'poster' | 'backdrop' | 'logo' | 'thumb' | 'still';

/**
 * A source for an image the route would fetch live from a provider when the
 * node stores none. TMDB answers posters, backdrops and logos of movies and
 * series, season posters and episode stills (each by the node's own id); the
 * Jellyfin provider answers every role. Nothing when the provider is off.
 */
function liveSource(node: ImageTagNode, role: LiveRole): string | null {
    const still = role === 'still';
    const chain = providerChain(node.media_type, still);
    const episode = isEpisode(node.media_type);
    const season = isSeason(node.media_type);
    const tmdbServes =
        !isMusicType(node.media_type) &&
        (episode
            ? still
            : season
              ? role === 'poster'
              : role === 'poster' || role === 'backdrop' || role === 'logo');
    if (node.tmdb_id && tmdbServes && chain.includes('tmdb')) {
        return `tmdb:${node.tmdb_id}:${role}`;
    }
    if (node.jellyfin_id && chain.includes('jellyfin')) {
        return `jf:${node.jellyfin_id}:${role}`;
    }
    return null;
}

/** Source of the image a client asks for as `Primary` on this node. */
function primarySource(node: ImageTagNode): string | null {
    if (node.canonicalRevisions?.Primary) return `canonical:${node.canonicalRevisions.Primary}`;
    // The /j image route serves an episode's Primary as its still, not a poster.
    return isEpisode(node.media_type)
        ? (node.still_src ?? liveSource(node, 'still'))
        : (node.poster_src ?? liveSource(node, 'poster'));
}

function backdropSource(node: ImageTagNode): string | null {
    if (node.canonicalRevisions?.Backdrop) return `canonical:${node.canonicalRevisions.Backdrop}`;
    // An episode's own backdrop: never its extracted frame, never a live
    // lookup (the route would answer with the series' backdrop).
    return isEpisode(node.media_type)
        ? node.backdrop_meta_src
        : (node.backdrop_src ?? liveSource(node, 'backdrop'));
}

function logoSource(node: ImageTagNode): string | null {
    if (node.canonicalRevisions?.Logo) return `canonical:${node.canonicalRevisions.Logo}`;
    if (node.logo_src) return node.logo_src;
    // Seasons and episodes have no logo of their own; the route's answer
    // would be the series logo, which ParentLogo* already points at.
    if (isEpisode(node.media_type) || isSeason(node.media_type)) return null;
    return liveSource(node, 'logo');
}

function thumbSource(node: ImageTagNode): string | null {
    if (node.canonicalRevisions?.Thumb) return `canonical:${node.canonicalRevisions.Thumb}`;
    // An episode's still is already its Primary; Jellyfin episodes carry no Thumb.
    if (isEpisode(node.media_type)) return null;
    return node.thumb_src ?? (isSeason(node.media_type) ? null : liveSource(node, 'thumb'));
}

/** Jellyfin `SupportsInheritedParentImages`. */
function inheritsParentImages(mediaType: string): boolean {
    return isEpisode(mediaType) || isSeason(mediaType) || isTrack(mediaType) || isAlbum(mediaType);
}

interface TagResult {
    tag: string;
    /** Blurhash Lumastra stored for exactly this image, when it has one. */
    blurhash: string | null;
}

function primaryTag(node: ImageTagNode): TagResult | null {
    const src = primarySource(node);
    if (!src) return null;
    // poster_blurhash is computed from the served poster; an episode's
    // Primary is its still, which has no stored hash.
    return {
        tag: jellyfinImageTag(node.id, 'Primary', src),
        blurhash: isEpisode(node.media_type) ? null : node.poster_blurhash,
    };
}

function backdropTag(node: ImageTagNode): TagResult | null {
    const src = backdropSource(node);
    if (!src) return null;
    return { tag: jellyfinImageTag(node.id, 'Backdrop', src), blurhash: node.backdrop_blurhash };
}

function plainTag(node: ImageTagNode, role: 'Logo' | 'Thumb'): TagResult | null {
    const src = role === 'Logo' ? logoSource(node) : thumbSource(node);
    return src ? { tag: jellyfinImageTag(node.id, role, src), blurhash: null } : null;
}

/**
 * Rewrites the image fields of `items` in place from what each item and its
 * parents own. Both sources share one bounded parent traversal for the whole list.
 */
export async function enrichItemsWithImages(
    sql: postgres.Sql,
    items: JellyfinBaseItemDto[],
): Promise<void> {
    if (items.length === 0) return;
    let loaded: Awaited<ReturnType<typeof getImageTagNodes>>;
    try {
        loaded = await getImageTagNodes(
            sql,
            items.map((i) => i.Id),
        );
    } catch (error) {
        // Artwork tags are decoration: a failed lookup leaves the serializer's
        // tags in place rather than failing the listing.
        logger.warn('Image tag lookup failed; keeping serializer tags', {
            count: items.length,
            error: error instanceof Error ? error.message : String(error),
        });
        return;
    }
    const { nodes, chains } = loaded;
    if (chains.size === 0) return;

    for (const item of items) {
        const chain = chains.get(item.Id);
        const self = chain ? nodes.get(chain.nodeIds[0]) : undefined;
        if (!chain || !self) continue;
        const ancestors = chain.nodeIds
            .slice(1)
            .map((id) => nodes.get(id))
            .filter((n): n is ImageTagNode => n !== undefined);
        applyImages(item, self, ancestors);
    }
}

/**
 * The tag `itemId` currently advertises for its own `role` image, or null
 * (unknown item, no such image, lookup failed). This fresh lookup is useful
 * for diagnostics; image responses recompute their tag from servedRevision
 * after the byte provider has checked it, avoiding another ancestor read.
 */
export async function currentImageTag(
    sql: postgres.Sql,
    itemId: string,
    role: ImageRole,
    servedRevision?: string,
): Promise<string | null> {
    try {
        const read = async (db: postgres.Sql): Promise<string | null> => {
            const { nodes } = await getImageTagNodes(db, [itemId]);
            const node = nodes.get(itemId);
            if (!node) return null;
            const result =
                role === 'Primary'
                    ? primaryTag(node)
                    : role === 'Backdrop'
                      ? backdropTag(node)
                      : plainTag(node, role);
            if (!result) return null;
            if (servedRevision && node.canonicalRevisions?.[role] !== servedRevision) return null;
            return result.tag;
        };
        // Legacy sources and canonical revisions now come from one SELECT,
        // so its statement snapshot is the byte/tag fence. A separate
        // BEGIN/SET TRANSACTION/COMMIT adds no consistency to this one read.
        return await read(sql);
    } catch (error) {
        logger.debug('Current image tag lookup failed', {
            itemId,
            role,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

/** Exported for unit tests: the Jellyfin DtoService rules over loaded nodes. */
export function applyImages(
    item: JellyfinBaseItemDto,
    self: ImageTagNode,
    ancestors: readonly ImageTagNode[],
): void {
    const hashes: Partial<Record<ImageRole, Record<string, string>>> = {};
    const note = (role: ImageRole, r: TagResult | null): string | undefined => {
        if (!r) return undefined;
        if (r.blurhash) (hashes[role] ??= {})[r.tag] = r.blurhash;
        return r.tag;
    };

    // ── The item's own images ────────────────────────────────────────────
    const imageTags: Record<string, string> = {};
    const primary = note('Primary', primaryTag(self));
    if (primary) imageTags.Primary = primary;
    const logo = note('Logo', plainTag(self, 'Logo'));
    if (logo) imageTags.Logo = logo;
    const thumb = note('Thumb', plainTag(self, 'Thumb'));
    if (thumb) imageTags.Thumb = thumb;
    const backdrop = note('Backdrop', backdropTag(self));
    // The serializer has always mirrored the backdrop into ImageTags as well;
    // keep that so no client that learnt to read it there loses it.
    if (backdrop) imageTags.Backdrop = backdrop;
    item.ImageTags = imageTags;
    item.BackdropImageTags = backdrop ? [backdrop] : [];

    // Reset what the serializer guessed from the browse row; set below from
    // what the parents really have.
    delete item.ParentPrimaryImageItemId;
    delete item.ParentPrimaryImageTag;
    delete item.ParentBackdropItemId;
    delete item.ParentBackdropImageTags;
    delete item.ParentLogoItemId;
    delete item.ParentLogoImageTag;
    delete item.ParentThumbItemId;
    delete item.ParentThumbImageTag;
    delete item.SeriesPrimaryImageTag;
    delete item.AlbumPrimaryImageTag;

    // ── Series poster (episodes, seasons) ────────────────────────────────
    if (isEpisode(self.media_type) || isSeason(self.media_type)) {
        const series = ancestors.find((a) => isSeries(a.media_type));
        const seriesPrimary = series ? note('Primary', primaryTag(series)) : undefined;
        if (series && seriesPrimary) item.SeriesPrimaryImageTag = seriesPrimary;

        // Episode: season poster first, else the series poster. Seasons keep
        // pointing at the series poster as the serializer always did.
        const season = isEpisode(self.media_type)
            ? ancestors.find((a) => isSeason(a.media_type))
            : undefined;
        const seasonPrimary = season ? note('Primary', primaryTag(season)) : undefined;
        if (season && seasonPrimary) {
            item.ParentPrimaryImageItemId = season.id;
            item.ParentPrimaryImageTag = seasonPrimary;
        } else if (series && seriesPrimary) {
            item.ParentPrimaryImageItemId = series.id;
            item.ParentPrimaryImageTag = seriesPrimary;
        }
    }

    // ── Album cover (tracks) ─────────────────────────────────────────────
    if (isTrack(self.media_type)) {
        const album = ancestors[0] && isAlbum(ancestors[0].media_type) ? ancestors[0] : undefined;
        if (album) {
            item.AlbumId ??= album.id;
            const albumPrimary = note('Primary', primaryTag(album));
            if (albumPrimary) item.AlbumPrimaryImageTag = albumPrimary;
        }
    }

    // ── Inherited logo / thumb / backdrop (AddInheritedImages) ───────────
    if (inheritsParentImages(self.media_type)) {
        for (const parent of ancestors) {
            if (!logo && !item.ParentLogoItemId) {
                const t = note('Logo', plainTag(parent, 'Logo'));
                if (t) {
                    item.ParentLogoItemId = parent.id;
                    item.ParentLogoImageTag = t;
                }
            }
            // A series thumb replaces a season's (`|| parent is Series`).
            if (!thumb && (!item.ParentThumbItemId || isSeries(parent.media_type))) {
                const t = note('Thumb', plainTag(parent, 'Thumb'));
                if (t) {
                    item.ParentThumbItemId = parent.id;
                    item.ParentThumbImageTag = t;
                }
            }
            if (!backdrop && !item.ParentBackdropItemId) {
                const t = note('Backdrop', backdropTag(parent));
                if (t) {
                    item.ParentBackdropItemId = parent.id;
                    item.ParentBackdropImageTags = [t];
                }
            }
            // Jellyfin stops at the series: a Series does not inherit further.
            if (isSeries(parent.media_type)) break;
        }
    }

    item.ImageBlurHashes = hashes;

    // PrimaryImageAspectRatio describes the image a client will draw for
    // Primary (AttachPrimaryImageAspectRatio): the item's own, else — episodes
    // and seasons — the series poster, else nothing at all. The value per
    // shape stays the serializer's (no per-image dimensions are stored).
    if (!primary) {
        if (item.SeriesPrimaryImageTag) {
            item.PrimaryImageAspectRatio = POSTER_ASPECT_RATIO;
        } else {
            delete item.PrimaryImageAspectRatio;
        }
    }
}
