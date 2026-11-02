// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { ArtistCreditChoiceSchema, ArtistCreditReviewSchema } from './music-credit-review.js';

const MemberName = z.string().trim().min(1).max(255);
export const CollaborationMemberSchema = z.union([
    z.strictObject({ id: z.uuid(), name: MemberName }),
    z.strictObject({ newName: MemberName }),
]);
export type CollaborationMember = z.infer<typeof CollaborationMemberSchema>;

export const CollaborationPreviewRequestSchema = z.strictObject({
    members: z.array(CollaborationMemberSchema).max(20).default([]),
});
export const CollaborationApplyRequestSchema = z.strictObject({
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    members: z.array(CollaborationMemberSchema).min(2).max(20),
    trackIds: z.array(z.uuid()).max(200),
    markReviewed: z
        .boolean()
        .optional()
        .describe('Ignored legacy field, including false; completion is calculated automatically'),
    albumOwnerAcknowledged: z
        .boolean()
        .optional()
        .describe('Legacy field; album owners are always retained'),
    keepDismissed: z.boolean().optional(),
});
export const CollaborationTrackPreviewSchema = z.object({
    id: z.uuid(),
    title: z.string().nullable(),
    albumId: z.uuid().nullable(),
    albumTitle: z.string().nullable(),
    albumArtistId: z.uuid().nullable(),
    albumArtistTitle: z.string().nullable(),
    sourceTag: z.string().nullable(),
    fileCount: z.number(),
    status: z.enum(['eligible', 'already-resolved', 'abstain']),
    reason: z.string().nullable(),
    before: ArtistCreditReviewSchema.shape.credits,
    after: z.array(ArtistCreditChoiceSchema),
    reviewSnapshot: z.string().nullable(),
});
export const CollaborationPreviewSchema = z.object({
    artist: z.object({ id: z.uuid(), title: z.string() }),
    members: z.array(CollaborationMemberSchema),
    suggestedNames: z.array(z.string()),
    witnesses: z.array(z.object({ member: z.string(), tags: z.array(z.string()) })),
    tracks: z.array(CollaborationTrackPreviewSchema).max(200),
    overflow: z.boolean(),
    albums: z.array(
        z.object({
            id: z.uuid(),
            title: z.string().nullable(),
            ownerId: z.uuid().nullable(),
            ownerTitle: z.string().nullable(),
        }),
    ),
    snapshot: z.string(),
    reviewed: z.boolean(),
});
export type CollaborationPreviewResult = z.infer<typeof CollaborationPreviewSchema>;
const CollaborationApplyResponseSchema = z.object({
    changedTracks: z.number().int().nonnegative(),
    unchangedAlbums: z.number().int().nonnegative(),
    reviewed: z.boolean(),
});
export const CollaborationRequestSchema = z.discriminatedUnion('action', [
    z.strictObject({
        action: z.literal('preview'),
        members: z.array(CollaborationMemberSchema).max(20).default([]),
    }),
    z.strictObject({
        action: z.literal('apply'),
        snapshot: z.string().regex(/^[a-f0-9]{64}$/),
        members: z.array(CollaborationMemberSchema).min(2).max(20),
        trackIds: z.array(z.uuid()).max(200),
        markReviewed: z
            .boolean()
            .optional()
            .describe(
                'Ignored legacy field, including false; completion is calculated automatically',
            ),
        albumOwnerAcknowledged: z
            .boolean()
            .optional()
            .describe('Legacy field; album owners are always retained'),
        keepDismissed: z.boolean().optional(),
    }),
    z.strictObject({ action: z.literal('return') }),
]);
export const CollaborationResponseSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('preview'), preview: CollaborationPreviewSchema }),
    z.object({ action: z.literal('apply'), result: CollaborationApplyResponseSchema }),
    z.object({ action: z.literal('return'), returned: z.boolean() }),
]);
export type CollaborationRequest = z.infer<typeof CollaborationRequestSchema>;
