// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { transformSeriesResult } from './transformer.js';
import type { SeriesMetadataDto } from './client.js';

const series = {
    seriesId: 1,
    name: 'Series',
    libraryId: 1,
    libraryName: 'Manga',
    format: 1,
} as unknown as Parameters<typeof transformSeriesResult>[0];

function overview(summary: string): string | undefined {
    return transformSeriesResult(series, { summary } as unknown as SeriesMetadataDto).overview;
}

describe('kavita summary HTML stripping', () => {
    it('decodes basic entities', () => {
        expect(overview('<p>Tom &amp; Jerry &lt;3</p>')).toBe('Tom & Jerry <3');
    });

    it('decodes once: &amp;lt; stays the literal text &lt;', () => {
        expect(overview('Use &amp;lt;b&amp;gt; for bold')).toBe('Use &lt;b&gt; for bold');
    });
});
