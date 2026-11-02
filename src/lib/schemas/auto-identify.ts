// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
export const AutoIdentifyResultSchema = z.object({
    matched: z.number().int().nonnegative().describe('Entries given an online match'),
    skipped: z.number().int().nonnegative().describe('Entries left unchanged'),
    failed: z.number().int().nonnegative().describe('Entries that could not be processed'),
    total: z.number().int().nonnegative().describe('Entries considered in the run'),
    message: z
        .string()
        .describe('Matching outcome, including any need for an explicit merge choice'),
    conflicts: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe('Online identities already owned by another entry; no merge was performed'),
    conflictItems: z
        .array(z.object({ id: z.uuid(), title: z.string() }))
        .max(200)
        .default([])
        .describe('First 200 entries with an existing owner of the online match'),
});
export const AutoIdentifySummarySchema = AutoIdentifyResultSchema.pick({
    matched: true,
    conflicts: true,
    conflictItems: true,
});
export type AutoIdentifyResult = z.infer<typeof AutoIdentifyResultSchema>;
export type AutoIdentifySummary = z.infer<typeof AutoIdentifySummarySchema>;
