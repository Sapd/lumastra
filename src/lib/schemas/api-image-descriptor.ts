// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image descriptor — the ONE image shape every item response carries (API
 * rework package 10, spec 2026-10-16-api-rework-package-10-images.md).
 *
 * A client never builds an image URL or walks a parent chain: the server
 * resolves the fallback per role (episode → season → series, track → album →
 * artist, ...), says where the bytes came from (`source`) and hands over ready,
 * base-relative hrefs.
 *
 * Convention: absent = no image for that role. Never null, never "".
 */

import { z } from 'zod';
import { ImageProviderSchema } from './image-candidates.js';

export const InheritQuerySchema = z.object({
    inherit: z.enum(['none']).optional().meta({
        description:
            "Return only the item's own images; roles that would be inherited from a season/series are omitted.",
    }),
});

/** Roles an `images` map can carry. Which ones a resource offers is documented per resource. */
export const IMAGE_SET_ROLES = [
    'poster',
    'backdrop',
    'logo',
    'thumb',
    'banner',
    'primary',
] as const;
export type ImageSetRole = (typeof IMAGE_SET_ROLES)[number];

/** Named size presets a descriptor can advertise as a `variants` key. */
export const IMAGE_VARIANT_NAMES = ['thumb', 'card', 'hd', 'wide', 'full'] as const;
export type ImageVariantName = (typeof IMAGE_VARIANT_NAMES)[number];

/** Where the image bytes of a role come from (own image or an ancestor/provider). */
export const IMAGE_SOURCES = [
    'self',
    'season',
    'series',
    'album',
    'artist',
    'provider',
    'generated',
    'frame',
] as const;
export type ImageSource = (typeof IMAGE_SOURCES)[number];

export const ImagePlaceholderSchema = z
    .object({
        blurhash: z
            .string()
            .optional()
            .meta({ description: 'BlurHash string (4x3 components) of the image.' }),
        color: z
            .string()
            .optional()
            .meta({ description: 'Dominant colour as `#rrggbb`, usable as a flat background.' }),
    })
    .meta({
        id: 'ImagePlaceholder',
        description: 'Cheap stand-in to show while the image loads. At least one field is set.',
    });

export const ImageVariantsSchema = z
    .object({
        thumb: z.string().optional().meta({ description: 'Smallest preset href (list rows).' }),
        card: z.string().optional().meta({ description: 'Card-sized preset href.' }),
        hd: z.string().optional().meta({ description: 'HD preset href.' }),
        wide: z.string().optional().meta({ description: 'Full-bleed (1080p-class) preset href.' }),
        full: z.string().optional().meta({ description: 'Unresized original href.' }),
    })
    .meta({
        id: 'ImageVariants',
        description:
            'Ready hrefs per named size preset. Only the presets the role offers are present. ' +
            'Each carries the same `revision` as `href`.',
    });

export const ImageDescriptorSchema = z
    .object({
        href: z.string().meta({
            description:
                'Ready, base-relative URL of the image at its default size. Fetch it as-is: no ' +
                'token, no URL building. Carries `?v=<revision>`, so a changed image gets a new ' +
                'URL and unchanged ones are cached long.',
        }),
        variants: ImageVariantsSchema.optional(),
        width: z
            .number()
            .int()
            .optional()
            .meta({ description: 'Pixel width of the original, when known.' }),
        height: z
            .number()
            .int()
            .optional()
            .meta({ description: 'Pixel height of the original, when known.' }),
        mediaType: z
            .string()
            .optional()
            .meta({ description: 'Content type served for `href`, e.g. `image/webp`.' }),
        revision: z.string().meta({
            description:
                'Opaque token that changes whenever the image bytes change. Compare for equality only.',
        }),
        source: z.enum(IMAGE_SOURCES).meta({
            description:
                "`self`: the item's own image. `season`/`series`/`album`/`artist`: inherited from " +
                'that ancestor by the documented fallback chain. `provider`: external metadata ' +
                'provider (own or inherited, see the resource docs). `generated`: rendered by the ' +
                'server (collage, initials avatar). `frame`: a still the server extracted from the ' +
                "video file itself (the item's own, but not a provider/uploaded still). Request `inherit=none` on the byte route to get " +
                "only the item's own image.",
        }),
        provider: ImageProviderSchema.optional().describe(
            'Origin of the selected image, independent of inheritance source. Absent when unknown to older servers.',
        ),
        placeholder: ImagePlaceholderSchema.optional(),
    })
    .meta({
        id: 'ImageDescriptor',
        description:
            'One image for one role, resolved by the server: ready URLs, size variants, ' +
            'provenance and a placeholder.',
    });

export const ImageSetSchema = z
    .object({
        poster: ImageDescriptorSchema.optional().meta({ description: 'Portrait cover art.' }),
        backdrop: ImageDescriptorSchema.optional().meta({
            description: 'Landscape background art.',
        }),
        logo: ImageDescriptorSchema.optional().meta({ description: 'Title logo (transparent).' }),
        thumb: ImageDescriptorSchema.optional().meta({
            description: 'Landscape card image (an episode still, a channel screenshot).',
        }),
        banner: ImageDescriptorSchema.optional().meta({ description: 'Wide banner art.' }),
        primary: ImageDescriptorSchema.optional().meta({
            description: 'Square art for music, audiobooks, people, users, stations, libraries.',
        }),
    })
    .meta({
        id: 'ImageSet',
        description:
            'Images by role. A role that has no image (after the documented fallback) is absent.',
    });

export type ImagePlaceholder = z.infer<typeof ImagePlaceholderSchema>;
export type ImageVariants = z.infer<typeof ImageVariantsSchema>;
export type ImageDescriptor = z.infer<typeof ImageDescriptorSchema>;
export type ImageSet = z.infer<typeof ImageSetSchema>;
