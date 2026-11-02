// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { apiUrl, buildCollageRefs, type ApiSurface } from '$lib/shared/api-urls.js';
import { buildImageSet } from '$lib/shared/image-descriptor.js';
import { imageRevision } from './revision.js';

/** A person without a known profile path has no advertised artwork. */
export function personImageSet(
    surface: ApiSurface,
    id: string | number,
    path?: string | null,
): ImageSet {
    if (!path) return {};
    const revision = imageRevision({ ownerId: String(id), role: 'profile', providerPath: path });
    const base = apiUrl(surface, `/people/${encodeURIComponent(id)}/images/profile`);
    const variants = Object.fromEntries(
        Object.entries({ thumb: 'w45', card: 'w185', full: 'original' }).map(([name, size]) => [
            name,
            `${base}?${new URLSearchParams({ size, v: revision })}`,
        ]),
    );
    return {
        primary: { href: variants.card, variants, revision, source: 'self', provider: 'tmdb' },
    };
}

export function channelImageSet(
    surface: ApiSurface,
    id: string,
    logo?: string | ImageSet | null,
): ImageSet {
    return buildImageSet(surface, {
        primary:
            logo && (typeof logo === 'string' || logo.primary)
                ? {
                      ownerId: id,
                      urlRole: 'poster',
                      revision:
                          typeof logo === 'string'
                              ? imageRevision({ ownerId: id, role: 'poster', customUrl: logo })
                              : (logo.primary?.revision ?? '0'),
                  }
                : undefined,
    });
}

export function libraryImageSet(
    surface: ApiSurface,
    id: string,
    contentHash: string | null,
): ImageSet {
    if (!contentHash) return {};
    const images: ImageSet = {};
    for (const role of ['primary', 'backdrop'] as const) {
        const base = apiUrl(surface, `/libraries/${id}/images/${role}`);
        const variants = Object.fromEntries(
            ['thumb', 'card', 'hd', 'full'].map((size) => [
                size,
                `${base}?${new URLSearchParams({ size, v: contentHash })}`,
            ]),
        );
        images[role] = {
            href: variants[role === 'backdrop' ? 'hd' : 'card'],
            variants,
            source: 'generated',
            provider: 'generated',
            revision: contentHash,
        };
    }
    return images;
}

export function audiobookImageSet(surface: ApiSurface, id: string, revision: string): ImageSet {
    return id
        ? buildImageSet(surface, { primary: { ownerId: id, urlRole: 'poster', revision } })
        : {};
}

/** Member order and member artwork revisions both affect the rendered collage. */
export function playlistImageSet(
    surface: ApiSurface,
    cover: string | null | undefined,
    members: { id: string; revision: string }[],
    coverRevision?: string,
): ImageSet {
    const revision = imageRevision({
        ownerId: 'playlist',
        role: 'primary',
        customUrl: cover,
        providerPath: JSON.stringify([coverRevision, members]),
    });
    if (cover) {
        const hashIndex = cover.indexOf('#');
        const path = hashIndex < 0 ? cover : cover.slice(0, hashIndex);
        const fragment = hashIndex < 0 ? '' : cover.slice(hashIndex);
        return {
            primary: {
                href: `${path}${path.includes('?') ? '&' : '?'}v=${revision}${fragment}`,
                revision,
                source: 'self',
            },
        };
    }
    const refs = buildCollageRefs(
        members.map((member) => member.id),
        surface,
    );
    if (!refs) return {};
    const version = (href: string): string =>
        `${href}${href.includes('?') ? '&' : '?'}v=${revision}`;
    return {
        primary: {
            href: version(refs.href),
            variants: {
                thumb: version(refs.thumb),
                card: version(refs.card),
                full: version(refs.full),
            },
            revision,
            source: 'generated',
            provider: 'generated',
        },
    };
}
