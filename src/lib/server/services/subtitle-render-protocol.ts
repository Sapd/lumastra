// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Structured work limits cross the worker boundary without source paths or track bytes. */
export interface SubtitleRenderCounts {
    references: number;
    uniqueBitmaps: number;
    renderedPixels: number;
    requestedPixels: number;
    maxPixels: number;
    maxReferences: number;
    limit: 'pixels' | 'references' | 'dimensions';
}

export class SubtitleRenderBudgetError extends Error {
    constructor(public readonly counts: SubtitleRenderCounts) {
        super(`Subtitle render ${counts.limit} budget exceeded`);
        this.name = 'SubtitleRenderBudgetError';
    }
}

export function isSubtitleRenderCounts(value: unknown): value is SubtitleRenderCounts {
    if (!value || typeof value !== 'object') return false;
    const counts = value as Partial<SubtitleRenderCounts>;
    return (
        (counts.limit === 'pixels' ||
            counts.limit === 'references' ||
            counts.limit === 'dimensions') &&
        [
            counts.references,
            counts.uniqueBitmaps,
            counts.renderedPixels,
            counts.requestedPixels,
            counts.maxPixels,
            counts.maxReferences,
        ].every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
    );
}
