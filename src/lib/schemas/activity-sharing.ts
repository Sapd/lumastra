// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const ActivitySharingDefaultSchema = z.object({
    sharing: z.boolean().describe('Whether new accounts share activity by default'),
});

export const ApplyActivitySharingDefaultBodySchema = z.object({
    confirmed: z
        .literal(true)
        .describe('Confirm applying the saved default to users without an explicit choice'),
    expectedDefault: z
        .boolean()
        .describe('Saved default shown in the confirmation; a changed default returns 409'),
});

export const ActivitySharingDefaultAppliedSchema = ActivitySharingDefaultSchema.extend({
    changedCount: z
        .number()
        .int()
        .nonnegative()
        .describe('Number of accounts whose sharing flags changed'),
});
