// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const IMAGE_PROVIDERS = [
    'tmdb',
    'tvdb',
    'fanart',
    'musicbrainz-caa',
    'discogs',
    'deezer',
    'theaudiodb',
    'lastfm',
    'local-folder',
    'embedded',
    'frame-extract',
    'generated',
    'upload',
    'jellyfin',
    'audiobookshelf',
    'unknown',
] as const;
export const ImageProviderSchema = z.enum(IMAGE_PROVIDERS);
export type ImageProvider = z.infer<typeof ImageProviderSchema>;
export const CandidateRoleSchema = z.enum(['poster', 'thumb', 'backdrop', 'logo', 'banner']);
export type CandidateRole = z.infer<typeof CandidateRoleSchema>;
export const ImageCandidateSchema = z.object({
    id: z.string().uuid(),
    media_item_id: z.string().uuid().nullable(),
    person_ref: z.string().nullable().optional(),
    artwork_type: CandidateRoleSchema,
    provider: ImageProviderSchema,
    provider_ref: z.string(),
    language: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    chosen_by: z.enum(['auto', 'admin', 'user']),
    fetched_at: z.string(),
    locked: z.boolean(),
    selected: z.boolean(),
    suppressed: z
        .boolean()
        .optional()
        .describe('Hidden from automatic artwork selection; the asset is retained.'),
    /** Canonical per-role order. Only meaningful for selected candidates. */
    selection_order: z
        .number()
        .int()
        .optional()
        .describe('Canonical order within selected candidates for this role.'),
    sort_order: z.number().int(),
    file_path: z.string().nullable(),
    remote_url: z.string().nullable(),
});
export type ImageCandidate = z.infer<typeof ImageCandidateSchema>;
export const CandidateMutationSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('select'), candidateId: z.string().uuid(), locked: z.boolean() }),
    z.object({ action: z.literal('lock'), candidateId: z.string().uuid(), locked: z.boolean() }),
    z.object({ action: z.literal('hide'), candidateId: z.uuid() }),
    z.object({ action: z.literal('automatic'), role: CandidateRoleSchema }),
    z.object({ action: z.literal('suppress-provider'), provider: ImageProviderSchema }),
    z.object({ action: z.literal('undo'), receiptId: z.uuid() }),
    z.object({
        action: z.literal('delete-provider'),
        provider: ImageProviderSchema,
        role: CandidateRoleSchema.optional(),
        mode: z.enum(['preview', 'apply']),
        fingerprint: z.string().optional(),
    }),
]);

export const ImageCandidateResultSchema = z.object({
    candidates: z.array(ImageCandidateSchema),
    fingerprint: z.string().optional(),
    applied: z.boolean(),
    deleted: z
        .number()
        .int()
        .optional()
        .describe('Deprecated: image references are retained; this is zero.'),
    hidden: z
        .number()
        .int()
        .optional()
        .describe('Number of retained image references hidden from election.'),
    undoId: z
        .uuid()
        .optional()
        .describe('Guarded receipt for restoring the preceding artwork choice.'),
});
