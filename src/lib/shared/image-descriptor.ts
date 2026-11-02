// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builders for the shared image descriptor (API rework package 10).
 *
 * Pure and synchronous: callers pass what they already know about a role
 * (which entity owns the bytes, where they came from, a revision) and get ready
 * base-relative hrefs back. The async resolution of the fallback chain lives in
 * the image service; these only format its answer.
 */

import type { ImageProvider } from '$lib/schemas/image-candidates.js';
import type {
    ImageDescriptor,
    ImagePlaceholder,
    ImageSet,
    ImageSetRole,
    ImageSource,
    ImageVariantName,
} from '$lib/schemas/api-image-descriptor.js';
import { apiBase, type ApiSurface, type ImageRole } from './api-urls.js';

/** Presets offered per URL role (mirrors the byte route's bounded presets). */
export const ROLE_VARIANTS: Record<string, readonly ImageVariantName[]> = {
    poster: ['thumb', 'card', 'full'],
    primary: ['thumb', 'card', 'full'],
    avatar: ['thumb', 'card', 'full'],
    backdrop: ['card', 'hd', 'wide', 'full'],
    thumb: ['thumb', 'card', 'full'],
    still: ['thumb', 'card', 'full'],
    banner: ['card', 'full'],
    logo: ['full'],
};

/** Default preset behind `href` per role. */
const DEFAULT_VARIANT: Record<string, ImageVariantName> = {
    poster: 'card',
    primary: 'card',
    avatar: 'card',
    backdrop: 'hd',
    thumb: 'card',
    still: 'card',
    banner: 'card',
    logo: 'full',
};

export interface ImageRoleSpec {
    /** Id of the entity whose image route serves the bytes (may be an ancestor). */
    ownerId: string;
    /** Role on the byte route (`/media/{ownerId}/images/{urlRole}`). Defaults to the set role. */
    urlRole?: ImageRole;
    source?: ImageSource;
    provider?: ImageProvider;
    /** Opaque; changes when bytes change. Falls back to '1' until the resolver supplies one. */
    revision?: string;
    width?: number;
    height?: number;
    mediaType?: string;
    placeholder?: ImagePlaceholder;
    /** Path prefix other than `/media/{id}/images` (e.g. `/users/{id}/images`). */
    basePath?: string;
}

function href(
    surface: ApiSurface,
    spec: ImageRoleSpec,
    urlRole: string,
    revision: string,
    size?: ImageVariantName,
): string {
    const base = spec.basePath ?? `/media/${spec.ownerId}/images`;
    const params = new URLSearchParams();
    if (size) params.set('size', size);
    params.set('v', revision);
    return `${apiBase(surface)}${base}/${urlRole}?${params}`;
}

export function buildImageDescriptor(
    surface: ApiSurface,
    role: ImageSetRole,
    spec: ImageRoleSpec,
): ImageDescriptor {
    const urlRole = spec.urlRole ?? (role as ImageRole);
    const revision = spec.revision ?? '1';
    const names = ROLE_VARIANTS[urlRole] ?? ['full'];
    const variants: Record<string, string> = {};
    for (const n of names) variants[n] = href(surface, spec, urlRole, revision, n);
    return {
        href: href(surface, spec, urlRole, revision, DEFAULT_VARIANT[urlRole] ?? 'full'),
        variants,
        ...(spec.width !== undefined && { width: spec.width }),
        ...(spec.height !== undefined && { height: spec.height }),
        ...(spec.mediaType && { mediaType: spec.mediaType }),
        revision,
        source: spec.source ?? 'self',
        ...(spec.provider && { provider: spec.provider }),
        ...(spec.placeholder && { placeholder: spec.placeholder }),
    };
}

/** Build an ImageSet from per-role specs; roles with an undefined spec are omitted. */
export function buildImageSet(
    surface: ApiSurface,
    specs: Partial<Record<ImageSetRole, ImageRoleSpec | undefined>>,
): ImageSet {
    const out: ImageSet = {};
    for (const [role, spec] of Object.entries(specs) as [
        ImageSetRole,
        ImageRoleSpec | undefined,
    ][]) {
        if (spec) out[role] = buildImageDescriptor(surface, role, spec);
    }
    return out;
}

/** The avatar byte route owns its source fallback; its stored version is the revision. */
export function userAvatarSet(
    surface: ApiSurface,
    {
        userId,
        version,
        generated = false,
    }: { userId: string; version: string; generated?: boolean },
): ImageSet {
    const images = buildImageSet(surface, {
        primary: {
            ownerId: userId,
            basePath: `/users/${encodeURIComponent(userId)}/images`,
            urlRole: 'avatar',
            source: generated ? 'generated' : 'self',
            revision: version,
        },
    });
    // Generated descriptors must explicitly opt into the byte route's initials
    // fallback; callers of the bare byte URL still get 404 on a miss.
    if (generated && images.primary) {
        images.primary.href += '&fallback=initials';
        images.primary.variants = Object.fromEntries(
            Object.entries(images.primary.variants ?? {}).map(([size, href]) => [
                size,
                `${href}&fallback=initials`,
            ]),
        );
    }
    return images;
}
