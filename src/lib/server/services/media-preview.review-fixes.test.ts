// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

vi.mock('./image-descriptor/resolver.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));

import { recommendationPreviews } from './media-preview.service.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const media = { id: UUID, type: 'movie', title: 'T', ids: {} };
const sql = {} as never;

describe('recommendationPreviews progress', () => {
    it('uses the score as progress fraction only for continue-watching', async () => {
        const [cw] = await recommendationPreviews(sql, 'v1', [
            { media, score: 0.4, reason: { kind: 'continue-watching' } },
        ]);
        expect(cw.progress?.fraction).toBe(0.4);
    });

    it.each(['watchlist', 'next-up'])('never derives progress from the ranking score for %s', async (kind) => {
        const [item] = await recommendationPreviews(sql, 'v1', [
            { media, score: 0.9, reason: { kind } },
        ]);
        expect(item.progress?.fraction ?? null).toBeNull();
    });
});
