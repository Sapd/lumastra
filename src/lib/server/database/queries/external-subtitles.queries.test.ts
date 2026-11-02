// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildUpsertExternalSubtitleQuery } from './external-subtitles.queries.js';

// Unit-test the parameter construction (no DB needed)
describe('buildUpsertExternalSubtitleQuery (params)', () => {
    it('accepts required params', () => {
        const params = {
            fileId: 'uuid-file',
            subtitlePath: '/movies/Movie.en.srt',
            format: 'srt' as const,
            language: 'en',
            isForced: false,
            isSDH: false,
        };
        expect(() => buildUpsertExternalSubtitleQuery(params)).not.toThrow();
    });

    it('accepts null language', () => {
        const params = {
            fileId: 'uuid-file',
            subtitlePath: '/movies/Movie.srt',
            format: 'srt' as const,
            language: null,
            isForced: false,
            isSDH: false,
        };
        expect(() => buildUpsertExternalSubtitleQuery(params)).not.toThrow();
    });
});
