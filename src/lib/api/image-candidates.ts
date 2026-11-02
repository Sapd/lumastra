// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { z } from 'zod';
import { apiGet, apiPost } from './client.js';
import {
    ImageCandidateResultSchema,
    type CandidateMutationSchema,
} from '$lib/schemas/image-candidates.js';

function endpoint(id: string): string {
    return id.startsWith('tmdb:')
        ? `/api/admin/people/${encodeURIComponent(id)}/images/candidates`
        : `/api/admin/media/${encodeURIComponent(id)}/images/candidates`;
}
export function getImageCandidates(id: string) {
    return apiGet(endpoint(id), ImageCandidateResultSchema);
}
export function curateImageCandidates(id: string, input: z.infer<typeof CandidateMutationSchema>) {
    return apiPost(endpoint(id), ImageCandidateResultSchema, input);
}
