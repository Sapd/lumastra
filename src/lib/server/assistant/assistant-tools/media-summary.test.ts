// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { toMediaSummary } from './media-summary.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';

const baseRow = {
    media_id: 'm1',
    primary_ext_id: '550',
    media_type: 'movie',
    title: 'X',
} as unknown as AssistantMovieRow;

describe('toMediaSummary — overview trimming (token saver)', () => {
    it('truncates long overviews on a word boundary with an ellipsis', () => {
        const long = 'word '.repeat(120).trim(); // ~600 chars
        const s = toMediaSummary({ ...baseRow, overview: long });
        expect(s.overview).not.toBeNull();
        expect(s.overview!.length).toBeLessThanOrEqual(201); // 200 + ellipsis
        expect(s.overview!.endsWith('…')).toBe(true);
        expect(s.overview!).not.toContain('  '); // trimmed cleanly
    });

    it('leaves short overviews untouched', () => {
        const s = toMediaSummary({ ...baseRow, overview: 'A short blurb.' });
        expect(s.overview).toBe('A short blurb.');
    });

    it('passes null overview through', () => {
        const s = toMediaSummary({ ...baseRow, overview: null });
        expect(s.overview).toBeNull();
    });
});

describe('toMediaSummary — watched flag', () => {
    it('emits watched:true when the row is watched', () => {
        const s = toMediaSummary({ ...baseRow, watched: true });
        expect(s.watched).toBe(true);
    });

    it('emits watched:false when the row is unwatched', () => {
        const s = toMediaSummary({ ...baseRow, watched: false });
        expect(s.watched).toBe(false);
    });

    it('treats a null/absent watched flag as false', () => {
        expect(toMediaSummary({ ...baseRow, watched: null }).watched).toBe(false);
        expect(toMediaSummary(baseRow).watched).toBe(false);
    });
});
