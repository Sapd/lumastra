// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { ImageDescriptorSchema } from './api-image-descriptor.js';

/**
 * Public identity: login usernames must never be used as display-name fallbacks.
 * `images.primary` is the same user avatar descriptor `GET /users` returns.
 */
export const publicAuthorSchema = z.object({
    userId: z.string().uuid(),
    displayName: z.string().nullable(),
    images: z.object({
        primary: ImageDescriptorSchema,
    }),
});

export type PublicAuthor = z.infer<typeof publicAuthorSchema>;
