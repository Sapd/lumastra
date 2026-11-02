// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { SimilarMediaResponseSchema } from './api-content-responses';

it('preserves the bounded MediaPreview response used by similar and context', () => {
    const response = {
        items: [
            {
                id: '42',
                catalogId: null,
                type: 'series',
                title: 'A match',
                ids: { tmdb: '42' },
                images: {},
                score: 0.9,
            },
        ],
        truncated: true,
    };
    expect(SimilarMediaResponseSchema.parse(response)).toEqual(response);
});
