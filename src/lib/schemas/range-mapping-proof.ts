// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

const decimal = z.string().regex(/^[0-9]{1,30}$/);
export const RangeMappingParticipantSchema = z
    .object({
        fileId: z.string().uuid(),
        path: z.string().min(1).max(4096),
        generation: z.string().regex(/^[a-f0-9]{32}$/),
        root: z.string().min(1).max(4096),
        realRoot: z.string().min(1).max(4096),
        realPath: z.string().min(1).max(4096),
        regularFile: z.literal(true),
        dev: decimal,
        ino: decimal,
        size: z.string().regex(/^[1-9][0-9]{0,29}$/),
        mtimeMs: decimal,
        mtimeNs: decimal,
        ctimeNs: decimal,
    })
    .strict();
/** Admin-only dated mapping observation. It makes no content-completeness claim. */
export const RangeMappingProofSchema = z
    .object({
        version: z.literal(1),
        observedAt: z.string().datetime(),
        participants: z.array(RangeMappingParticipantSchema).min(3).max(51),
    })
    .strict();
export type RangeMappingProof = z.infer<typeof RangeMappingProofSchema>;
export type RangeMappingParticipant = z.infer<typeof RangeMappingParticipantSchema>;
export const AdminRangeMappingSchema = z.object({
    state: z.enum(['current', 'unproven']),
    proof: RangeMappingProofSchema.optional(),
});
export type AdminRangeMapping = z.infer<typeof AdminRangeMappingSchema>;
