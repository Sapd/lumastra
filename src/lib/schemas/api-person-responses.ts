// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { MediaPreviewSchema } from './api-media-preview.js';
import { ImageSetSchema } from './api-image-descriptor.js';

/** Null only when the provider truly supplies no usable person identity; images are then omitted. */
export const PersonRefSchema = z
    .object({
        id: z
            .string()
            .nullable()
            .describe('Canonical person handle; null only when identity is unknown'),
        name: z.string(),
        images: ImageSetSchema.optional().describe(
            'Profile artwork; omitted when person identity is unknown',
        ),
    })
    .meta({ id: 'PersonRef' });

export const PersonCreditsSchema = z
    .object({
        cast: z.array(
            z.object({
                person: PersonRefSchema,
                character: z.string().optional(),
                order: z.number().int(),
            }),
        ),
        crew: z.array(
            z.object({
                person: PersonRefSchema,
                job: z.string(),
                department: z.string().optional(),
            }),
        ),
    })
    .meta({
        id: 'PersonCredits',
        description: 'Cast and crew, including Director, Creator and Writer jobs',
    });

export const PersonCreditSchema = MediaPreviewSchema.extend({
    character: z.string().optional(),
    job: z.string().optional(),
    episodeCount: z.number().optional(),
}).meta({
    id: 'PersonCredit',
    description: 'Filmography preview; catalogId is present only in accessible libraries',
});
export type PersonCredit = z.infer<typeof PersonCreditSchema>;

export const PersonDetailResponseSchema = z
    .object({
        id: z.string().describe('Canonical person handle, e.g. tmdb:123'),
        ids: z.record(z.string(), z.string()),
        name: z.string(),
        biography: z.string().optional(),
        birthday: z.string().optional(),
        deathday: z.string().optional(),
        placeOfBirth: z.string().optional(),
        knownForDepartment: z.string().optional(),
        popularity: z.number().optional(),
        images: ImageSetSchema,
        movieCredits: z.array(PersonCreditSchema),
        tvCredits: z.array(PersonCreditSchema),
        creditsTruncated: z
            .boolean()
            .describe('At least one filmography array exceeded the 30-credit cap'),
    })
    .meta({
        id: 'PersonDetailResponse',
        description: 'Person biography, profile images and accessible filmography previews',
    });
export type PersonDetailResponse = z.infer<typeof PersonDetailResponseSchema>;
