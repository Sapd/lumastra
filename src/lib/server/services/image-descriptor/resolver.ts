// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import {
    IMAGE_SET_ROLES,
    type ImageSet,
    type ImageSetRole,
} from '$lib/schemas/api-image-descriptor.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { buildImageSet, type ImageRoleSpec } from '$lib/shared/image-descriptor.js';
import {
    getImageDescriptorOwners,
    type ImageOwnerRow,
    type ArtworkRole,
} from '$lib/server/database/queries/image-descriptor.queries.js';
import { isSeason, isSeries, isAlbum, isArtist } from '$lib/server/utils/media-types.js';
import { chainFor, type ChainStep } from './chains.js';
import { imageRevision } from './revision.js';

export interface ResolveImageOptions {
    inherit?: 'chain' | 'none';
}
export interface ImageItem {
    id: string;
    mediaType?: string;
}

function matchesOwner(row: ImageOwnerRow, owner: ChainStep['owner']): boolean {
    return owner === 'season'
        ? isSeason(row.media_type)
        : owner === 'series'
          ? isSeries(row.media_type)
          : owner === 'album'
            ? isAlbum(row.media_type)
            : owner === 'artist'
              ? isArtist(row.media_type) && !row.is_various_artists
              : false;
}

/** Shared display-time selection for descriptors and album byte requests. No writes. */
export function resolveImageSpecsForOwner(
    own: ImageOwnerRow,
    owners: ReadonlyMap<string, ImageOwnerRow>,
    opts: ResolveImageOptions = {},
): Partial<Record<ImageSetRole, ImageRoleSpec>> {
    const specs: Partial<Record<ImageSetRole, ImageRoleSpec>> = {};
    const ancestors: ImageOwnerRow[] = [];
    let parentId = own.parent_id;
    for (let depth = 0; depth < 3 && parentId; depth++) {
        const parent = owners.get(parentId);
        if (!parent) break;
        ancestors.push(parent);
        parentId = parent.parent_id;
    }
    for (const role of IMAGE_SET_ROLES) {
        for (const step of chainFor(own.media_type, role)) {
            if (opts.inherit === 'none' && step.owner !== 'self') continue;
            const owner =
                step.owner === 'self'
                    ? own
                    : ancestors.find((row) => matchesOwner(row, step.owner));
            if (!owner || !['poster', 'backdrop', 'logo', 'thumb', 'banner'].includes(step.role))
                continue;
            const slot = step.role as ArtworkRole;
            const candidate = owner.selected_candidates?.[slot];
            // Legacy files and provider pointers remain available while committed
            // capture batches have not reached this owner. The byte route can discover them.
            if (
                !candidate &&
                (owner.suppressed_roles?.includes('*') || owner.suppressed_roles?.includes(slot))
            )
                continue;
            const local = owner.local_artwork[slot]?.path ? owner.local_artwork[slot] : undefined;
            // The episode's own backdrop slot is only the extracted frame when a local
            // row holds it; a provider/custom backdrop is not an episode still.
            const frameStep = step.owner === 'self' && role === 'thumb' && step.role === 'backdrop';
            const providerPath = frameStep ? undefined : owner.provider_paths[slot];
            const customUrl = frameStep ? undefined : owner.custom_urls[slot];
            if (!candidate && !local && !providerPath && !customUrl) continue;
            const blurhash =
                slot === 'poster'
                    ? owner.poster_blurhash
                    : slot === 'backdrop'
                      ? owner.backdrop_blurhash
                      : null;
            const spec: ImageRoleSpec = {
                ownerId: owner.id,
                ...(candidate && {
                    provider: candidate.provider,
                    width: candidate.width ?? undefined,
                    height: candidate.height ?? undefined,
                }),
                urlRole: slot,
                source:
                    step.owner === 'self'
                        ? candidate?.provider === 'frame-extract' ||
                          (role === 'thumb' && step.role === 'backdrop')
                            ? 'frame'
                            : candidate?.provider === 'generated'
                              ? 'generated'
                              : 'self'
                        : isSeason(owner.media_type)
                          ? 'season'
                          : isSeries(owner.media_type)
                            ? 'series'
                            : isArtist(owner.media_type)
                              ? 'artist'
                              : 'album',
                revision: imageRevision({
                    ownerId: owner.id,
                    role: slot,
                    localPath: candidate?.file_path ?? local?.path,
                    localUpdatedAt: candidate
                        ? `${candidate.id}:${candidate.fetched_at}:${candidate.locked}:${candidate.selected}:${local?.updatedAt ?? ''}:${candidate.local_content_hash ?? ''}`
                        : local?.updatedAt,
                    providerPath:
                        candidate?.provider === 'audiobookshelf'
                            ? `${candidate.provider_ref}:${owner.abs_cover_path ?? ''}:${owner.abs_cover_updated_at ?? ''}`
                            : (candidate?.provider_ref ?? providerPath),
                    customUrl: candidate ? candidate.remote_url : customUrl,
                    preferredProvider: candidate?.provider ?? owner.preferred_provider,
                }),
                ...(blurhash && { placeholder: { blurhash } }),
            };
            specs[role] = spec;
            break;
        }
    }
    return specs;
}

/** DB only: the single batched read is independent of item count and role count. */
export async function resolveImageSets(
    sql: postgres.Sql,
    surface: ApiSurface,
    items: ImageItem[],
    opts: ResolveImageOptions = {},
): Promise<Map<string, ImageSet>> {
    const result = new Map<string, ImageSet>();
    if (!items.length) return result;
    const rows = await getImageDescriptorOwners(
        sql,
        items.map(({ id }) => id),
    );
    const owners = new Map(rows.map((row) => [row.id, row]));
    for (const item of items) {
        const own = owners.get(item.id);
        const specs = own ? resolveImageSpecsForOwner(own, owners, opts) : {};
        result.set(item.id, buildImageSet(surface, specs));
    }
    return result;
}

/** Missing items have an empty ImageSet, just like items without artwork. */
export async function resolveImageSet(
    sql: postgres.Sql,
    surface: ApiSurface,
    id: string,
    mediaType?: string,
    opts?: ResolveImageOptions,
): Promise<ImageSet> {
    return (await resolveImageSets(sql, surface, [{ id, mediaType }], opts)).get(id) ?? {};
}

export { userAvatarSet } from '$lib/shared/image-descriptor.js';
