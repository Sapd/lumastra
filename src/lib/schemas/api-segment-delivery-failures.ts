// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Response schemas for the admin segment-delivery-failure list endpoint
 * (`GET /admin/segment-delivery-failures`). Single source of truth per this
 * codebase's Zod-schemas convention.
 */

import { z } from 'zod';

export const SegmentFailureCategorySchema = z.enum([
    'not_ready',
    'gone',
    'forbidden',
    'bad_request',
    'server_error',
]);

export const SegmentResourceKindSchema = z.enum([
    'segment',
    'init',
    'media_playlist',
    'master_playlist',
    'subtitle',
    'other',
]);

export const SegmentDeliveryFailureSummarySchema = z.object({
    id: z.string().describe('Row id (segment_delivery_failures.id)'),
    playSessionId: z
        .string()
        .describe(
            'Play session id exactly as the failing request carried it — native clients send it uppercase',
        ),
    category: SegmentFailureCategorySchema.describe(
        "Broad reason. 'not_ready' (503) is the handler deliberately telling a client to retry while a job spins up; 'gone' (404/410) mid-session is the one that strands Apple players",
    ),
    httpStatus: z.number().int(),
    resourceKind: SegmentResourceKindSchema.describe('What was being fetched, from the path shape'),
    streamVariant: z
        .string()
        .nullable()
        .describe('Stream directory (e.g. video_0), or null when the path had none'),
    occurrences: z
        .number()
        .int()
        .describe('Times this exact failure repeated — a retry storm collapses into one row'),
    firstSeenAt: z.string().describe('ISO timestamp of the first occurrence'),
    lastSeenAt: z.string().describe('ISO timestamp of the most recent occurrence'),
    userId: z
        .string()
        .nullable()
        .describe('Joined from play_sessions; null when the id matched none'),
    mediaId: z.string().nullable(),
    deviceId: z.string().nullable(),
    clientName: z.string().nullable(),
    username: z.string().nullable(),
    mediaTitle: z.string().nullable(),
});

/** Mirrors the codebase-wide `{ items, page }` collection envelope. */
export const SegmentDeliveryFailurePageSchema = z.object({
    limit: z.number().int(),
    offset: z.number().int().optional(),
    hasMore: z.boolean(),
    total: z.number().int().optional(),
});

export const SegmentDeliveryFailureListResponseSchema = z.object({
    items: z.array(SegmentDeliveryFailureSummarySchema),
    page: SegmentDeliveryFailurePageSchema,
});

/** DELETE response for the admin list's clear button. */
export const SegmentDeliveryFailureClearedResponseSchema = z.object({
    cleared: z.number().int(),
});

export type SegmentDeliveryFailureSummary = z.infer<typeof SegmentDeliveryFailureSummarySchema>;
